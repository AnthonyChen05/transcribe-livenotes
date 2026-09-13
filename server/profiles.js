// Profiles: named scenario presets (topic, speaker accents, style guide)
// that steer every AI feature — on-demand commands and the auto-notes job —
// for the current recorded session. Stored in data/profiles.json; the active
// profile id lives in the main config.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES_FILE = path.join(ROOT, 'data', 'profiles.json');

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let profiles = load();

export function listProfiles() {
  return profiles;
}

export function saveProfiles() {
  fs.mkdirSync(path.dirname(PROFILES_FILE), { recursive: true });
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
}

export function getProfile(id) {
  return profiles.find((p) => p.id === id) || null;
}

const field = (v) => (typeof v === 'string' ? v.trim().slice(0, 2000) : '');

export function upsertProfile(input) {
  const name = field(input?.name);
  if (!name) throw new Error('Profile name is required');
  const profile = {
    id: input.id || randomUUID(),
    name,
    topic: field(input.topic),
    accent: field(input.accent),
    style: field(input.style),
  };
  const idx = profiles.findIndex((p) => p.id === profile.id);
  if (idx === -1) profiles.push(profile);
  else profiles[idx] = profile;
  saveProfiles();
  return profile;
}

export function deleteProfile(id) {
  profiles = profiles.filter((p) => p.id !== id);
  saveProfiles();
  return getProfile(id) === null;
}

/** Compose the profile into an instruction block for Ollama prompts. */
export function buildProfileContext(profile) {
  if (!profile) return '';
  const lines = [];
  if (profile.topic?.trim()) lines.push(`Topic / scenario: ${profile.topic.trim()}`);
  if (profile.accent?.trim()) {
    lines.push(
      `Speakers' accents: ${profile.accent.trim()}. The transcript may contain mishearings because of this; use the context to interpret what was meant.`
    );
  }
  if (profile.style?.trim()) lines.push(`Style guide for the notes: ${profile.style.trim()}`);
  return lines.join('\n');
}