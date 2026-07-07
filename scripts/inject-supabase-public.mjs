#!/usr/bin/env node
/**
 * Netlify build step — inject public Supabase URL + anon key into index.html.
 * Set in Netlify: Site configuration → Environment variables
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY  (Supabase Dashboard → Project Settings → API → anon / publishable)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const indexPath = path.join(root, 'index.html');

const url = process.env.SUPABASE_URL || 'https://tjxiaidxcwpvsnwfvdck.supabase.co';
const anon = process.env.SUPABASE_ANON_KEY;

if (!anon) {
  console.error(
    '[inject-supabase-public] FATAL: SUPABASE_ANON_KEY is not set.\n'
    + '  Netlify → Site configuration → Environment variables\n'
    + '  Supabase → Project Settings → API → anon public (or publishable) key'
  );
  process.exit(1);
}

if (!url.includes('.supabase.co')) {
  console.error(
    `[inject-supabase-public] FATAL: SUPABASE_URL must be your Supabase project URL (https://xxx.supabase.co), got: ${url}`
  );
  process.exit(1);
}

let html = fs.readFileSync(indexPath, 'utf8');
html = html
  .replaceAll('__SUPABASE_URL__', url)
  .replaceAll('__SUPABASE_ANON_KEY__', anon);
fs.writeFileSync(indexPath, html);
console.log('[inject-supabase-public] Injected Supabase public config into index.html');
