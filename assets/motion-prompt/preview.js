const canvas = document.querySelector('canvas');
const context = canvas.getContext('2d');
const cell = pack.cells[Number(canvas.dataset.cell)];
const toggle = document.querySelector('button');
const seek = document.querySelector('input');
canvas.width = pack.width;
canvas.height = pack.height;

let time = pack.cycle / 4;
let frame = 0;
let last = null;
let started = false;

function draw() {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  cell(context, canvas.width, canvas.height, time);
  context.restore();
  seek.value = String(Math.floor(time / pack.cycle * Number(seek.max)));
}

function tick(now) {
  if (last !== null) time = (time + (now - last) / 1000) % pack.cycle;
  last = now;
  draw();
  frame = requestAnimationFrame(tick);
}

function pause() {
  cancelAnimationFrame(frame);
  frame = 0;
  last = null;
  toggle.textContent = '播放';
}

toggle.addEventListener('click', () => {
  if (frame) {
    pause();
  } else {
    if (!started) time = 0;
    started = true;
    toggle.textContent = '暂停';
    frame = requestAnimationFrame(tick);
  }
});

seek.addEventListener('input', () => {
  pause();
  started = true;
  time = Number(seek.value) / Number(seek.max) * (pack.cycle - 0.001);
  const value = seek.value;
  draw();
  seek.value = value;
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});

draw();
