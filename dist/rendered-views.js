const captures = {
  cross: ['Crosslight', './evidence/meadow-1080.jpg'],
  front: ['Front light', './preview.jpg'],
  back: ['Backlight', './evidence/meadow-back-1080.jpg'],
  shade: ['Woodland', './evidence/meadow-shade-1080.jpg'],
  botany: ['Underfoot', './evidence/meadow-botany-1080.jpg']
};

export function showRenderedViews(reason) {
  const gallery = document.getElementById('renderedViews');
  const image = document.getElementById('renderedFrame');
  const video = document.getElementById('renderedWalk');
  const save = document.getElementById('saveRendered');
  document.getElementById('loading').hidden = true;
  document.getElementById('interface').hidden = true;
  document.getElementById('scene').hidden = true;
  document.getElementById('galleryStatus').textContent = reason;
  gallery.hidden = false;
  const choices = gallery.querySelectorAll('[data-capture]');
  function select(name) {
    const walking = name === 'walk';
    for (const button of choices) {
      const active = button.dataset.capture === name;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('active', active);
    }
    video.pause();
    video.hidden = !walking;
    image.hidden = walking;
    if (walking) {
      if (!video.hasAttribute('src')) video.src = './evidence/meadow-motion.mp4';
      video.play().catch(() => {}); // Native controls also allow explicit playback.
      save.href = video.src;
      save.download = 'CYBR-Forest-walk.mp4';
      save.textContent = 'Save video';
    } else {
      const [label, src] = captures[name];
      image.src = src;
      image.alt = label + ' captured from CYBR Forest';
      save.href = src;
      save.download = 'CYBR-Forest-' + name + '.jpg';
      save.textContent = 'Save frame';
    }
  }
  for (const button of choices) button.addEventListener('click', () => select(button.dataset.capture));
  select('front');
}
