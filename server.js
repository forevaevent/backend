const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

// In-memory job store (use Redis in production)
const jobs = {};

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── Start an outreach job ─────────────────────────────────────────────────────
app.post('/api/outreach/run', async (req, res) => {
  const { leads, message, senderName, senderEmail } = req.body;

  if (!leads || !leads.length || !message) {
    return res.status(400).json({ error: 'leads and message are required' });
  }

  const jobId = uuidv4();
  jobs[jobId] = {
    id: jobId,
    status: 'running',
    createdAt: new Date().toISOString(),
    leads: leads.map(l => ({
      id: l.id,
      business_name: l.business_name,
      website: l.website,
      status: 'queued',   // queued | visiting | finding_form | filling | submitted | failed
      step: 'Queued',
      error: null,
    })),
  };

  res.json({ jobId });

  // Run automation in background (do NOT await here)
  runAutomation(jobId, leads, message, senderName, senderEmail);
});

// ─── Poll job status ───────────────────────────────────────────────────────────
app.get('/api/outreach/job/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ─── Automation engine ─────────────────────────────────────────────────────────
async function runAutomation(jobId, leads, message, senderName, senderEmail) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const jobLead = jobs[jobId].leads[i];

    if (!lead.website) {
      jobLead.status = 'failed';
      jobLead.step = 'No website';
      jobLead.error = 'No website URL found for this lead';
      continue;
    }

    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(20000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

    try {
      // Step 1: Visit website
      jobLead.status = 'visiting';
      jobLead.step = 'Visiting website...';
      await page.goto(ensureHttp(lead.website), { waitUntil: 'domcontentloaded' });

      // Step 2: Find contact page
      jobLead.status = 'finding_form';
      jobLead.step = 'Finding contact page...';
      const contactUrl = await findContactPage(page, lead.website);
      if (contactUrl && contactUrl !== page.url()) {
        await page.goto(contactUrl, { waitUntil: 'domcontentloaded' });
      }

      // Step 3: Fill form
      jobLead.status = 'filling';
      jobLead.step = 'Filling contact form...';
      const filled = await fillContactForm(page, {
        name: senderName || 'Interested Party',
        email: senderEmail || 'contact@example.com',
        message: message
          .replace(/\{business_name\}/g, lead.business_name || '')
          .replace(/\{city\}/g, lead.city || '')
          .replace(/\{category\}/g, lead.category || ''),
      });

      if (!filled) {
        jobLead.status = 'failed';
        jobLead.step = 'No contact form found';
        jobLead.error = 'Could not find a fillable contact form on this site';
        await page.close();
        continue;
      }

      // Step 4: Submit
      jobLead.step = 'Submitting form...';
      await submitForm(page);
      await new Promise(r => setTimeout(r, 2000));

      jobLead.status = 'submitted';
      jobLead.step = 'Message sent ✓';

    } catch (err) {
      jobLead.status = 'failed';
      jobLead.step = 'Failed';
      jobLead.error = err.message;
    } finally {
      await page.close();
    }

    // Small delay between leads to be polite
    await new Promise(r => setTimeout(r, 1500));
  }

  await browser.close();
  jobs[jobId].status = 'done';
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function ensureHttp(url) {
  if (!url) return url;
  return url.startsWith('http') ? url : `https://${url}`;
}

async function findContactPage(page, baseUrl) {
  try {
    // Look for links containing "contact" on the current page
    const contactHref = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      const contact = links.find(a => {
        const text = (a.textContent || '').toLowerCase();
        const href = (a.getAttribute('href') || '').toLowerCase();
        return text.includes('contact') || href.includes('contact');
      });
      return contact ? contact.href : null;
    });
    return contactHref;
  } catch {
    return null;
  }
}

async function fillContactForm(page, { name, email, message }) {
  try {
    return await page.evaluate(({ name, email, message }) => {
      let filled = false;

      // Find name field
      const nameField = document.querySelector(
        'input[name*="name" i], input[placeholder*="name" i], input[id*="name" i], input[autocomplete="name"]'
      );
      if (nameField) { nameField.value = name; nameField.dispatchEvent(new Event('input', { bubbles: true })); filled = true; }

      // Find email field
      const emailField = document.querySelector(
        'input[type="email"], input[name*="email" i], input[placeholder*="email" i], input[id*="email" i]'
      );
      if (emailField) { emailField.value = email; emailField.dispatchEvent(new Event('input', { bubbles: true })); filled = true; }

      // Find message / textarea
      const msgField = document.querySelector(
        'textarea, input[name*="message" i], input[name*="msg" i], input[placeholder*="message" i]'
      );
      if (msgField) { msgField.value = message; msgField.dispatchEvent(new Event('input', { bubbles: true })); filled = true; }

      return filled;
    }, { name, email, message });
  } catch {
    return false;
  }
}

async function submitForm(page) {
  try {
    // Try clicking submit button
    await page.evaluate(() => {
      const btn = document.querySelector(
        'button[type="submit"], input[type="submit"], button:contains("Send"), button:contains("Submit")'
      );
      if (btn) btn.click();
      else {
        // Try the closest form's submit
        const form = document.querySelector('form');
        if (form) form.submit();
      }
    });
  } catch {
    // Try keyboard Enter as fallback
    await page.keyboard.press('Enter');
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`LeadStream backend running on port ${PORT}`));
