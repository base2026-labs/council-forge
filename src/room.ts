import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const ROOM_URI = 'ui://council-forge/room-v1.html';
export function roomHtml() {
  const read = (file: string) =>
    readFileSync(fileURLToPath(new URL(`../public/${file}`, import.meta.url)), 'utf8');
  return read('room.html')
    .replace('/* COUNCIL_ROOM_CSS */', read('room.css'))
    .replace('/* COUNCIL_ROOM_JS */', read('room.js'));
}
