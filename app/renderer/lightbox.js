'use strict';

const params = new URLSearchParams(window.location.search);
const src = params.get('src') || '';
const alt = params.get('alt') || '';

const photo = document.getElementById('photo');
const zoomLabel = document.getElementById('zoom-label');
const nameEl = document.getElementById('name');

let zoom = 1;
let panX = 0;
let panY = 0;
let dragging = false;
let dragStart = null;

function apply() {
  photo.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
}

function clampZoom(value) {
  return Math.min(6, Math.max(0.25, value));
}

function reset() {
  zoom = 1;
  panX = 0;
  panY = 0;
  apply();
}

photo.addEventListener('load', () => {
  nameEl.textContent = alt || src.split('/').pop() || '图片预览';
  reset();
});

photo.addEventListener('error', () => {
  nameEl.textContent = '这张图片没有加载出来';
});

if (src) photo.src = src;

photo.addEventListener('wheel', (event) => {
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1.08 : 0.92;
  zoom = clampZoom(zoom * factor);
  if (zoom <= 1) {
    panX = 0;
    panY = 0;
  }
  apply();
}, { passive: false });

photo.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  dragging = true;
  dragStart = { x: event.clientX - panX, y: event.clientY - panY };
  photo.classList.add('dragging');
  photo.setPointerCapture(event.pointerId);
});

photo.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  panX = event.clientX - dragStart.x;
  panY = event.clientY - dragStart.y;
  apply();
});

function endDrag() {
  dragging = false;
  photo.classList.remove('dragging');
}
photo.addEventListener('pointerup', endDrag);
photo.addEventListener('pointercancel', endDrag);

photo.addEventListener('dblclick', () => {
  zoom = zoom > 1.05 ? 1 : 2;
  panX = 0;
  panY = 0;
  apply();
});

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (src) window.lightbox.save({ url: src, name: src.split('/').pop() });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.lightbox.close();
  if (event.key === '+' || event.key === '=') {
    zoom = clampZoom(zoom * 1.1);
    apply();
  }
  if (event.key === '-') {
    zoom = clampZoom(zoom / 1.1);
    apply();
  }
});

document.getElementById('save').addEventListener('click', () => {
  if (src) window.lightbox.save({ url: src, name: src.split('/').pop() });
});
document.getElementById('close').addEventListener('click', () => window.lightbox.close());
document.getElementById('zoom-in').addEventListener('click', () => {
  zoom = clampZoom(zoom * 1.15);
  apply();
});
document.getElementById('zoom-out').addEventListener('click', () => {
  zoom = clampZoom(zoom / 1.15);
  if (zoom <= 1) { panX = 0; panY = 0; }
  apply();
});

document.addEventListener('click', (event) => {
  if (event.target === document.body) window.lightbox.close();
});

reset();
