/* ==========================================================================
   Nataly Hernandez — Portfolio 2026
   1. Fit the display type to the card
   2. Timeline: colour stack holds → pixel dissolve → name revealed (one shot)
   3. Interactive pixel-ball field on the black background
   ========================================================================== */

(() => {
  "use strict";

  const body = document.body;
  const stack = document.getElementById("stack");
  const canvas = document.getElementById("field");
  const ctx = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ========================================================================
     1 — Display type that always fits its card
     ======================================================================== */

  const nameEl = stack.querySelector(".plate--under .name");
  const roleEl = stack.querySelector(".plate--under .role");
  let fitFrame = 0;

  // Measure off-screen with max-content so the card can never clamp the probe.
  function measureText(el, size) {
    const probe = el.cloneNode(true);
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:absolute;left:-99999px;top:0;width:max-content;max-width:none;visibility:hidden;pointer-events:none;font-size:" +
      size +
      "px;";
    stack.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width || 1;
  }

  function fitType() {
    const width = stack.clientWidth;
    if (!width) return;

    const nameW = measureText(nameEl, 100);
    const roleW = measureText(roleEl, 100);

    const nameSize = Math.min(180, Math.max(13, (width * 0.735) / (nameW / 100)));
    const roleSize = Math.min(28, Math.max(9, (width * 0.55) / (roleW / 100)));

    stack.style.setProperty("--name-size", nameSize.toFixed(2) + "px");
    stack.style.setProperty("--role-size", roleSize.toFixed(2) + "px");
  }

  function queueFit() {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(fitType);
  }

  fitType();
  window.addEventListener("load", fitType);
  if (document.fonts) {
    document.fonts.ready.then(fitType);
    if (document.fonts.addEventListener) {
      document.fonts.addEventListener("loadingdone", fitType);
    }
  }

  if ("ResizeObserver" in window) {
    new ResizeObserver(queueFit).observe(stack);
  }
  window.addEventListener("resize", queueFit, { passive: true });

  /* ========================================================================
     2 — Pixel-art dissolve
     ------------------------------------------------------------------------
     The previous version animated an feTurbulence filter on every card. Each
     frame the browser had to regenerate the noise and re-run the whole filter
     chain (turbulence -> colour matrix -> transfer -> composite) over a
     full-size layer, which is why it crawled.

     This version renders the colour stack into a deliberately tiny canvas —
     one canvas pixel per "pixel-art" block — so a frame is a few thousand
     integer comparisons plus a single putImageData. The canvas is then
     upscaled with nearest-neighbour filtering, which is what gives the
     dissolve its chunky pixel-art look. All four layers share one threshold
     field, so the stack burns away as a single object.
     ======================================================================== */

  const cards = Array.from(stack.querySelectorAll(".card"));

  const dissolveCanvas = document.getElementById("dissolve");
  const dctx = dissolveCanvas.getContext("2d", { alpha: true });

  // 8×8 ordered (Bayer) dither matrix — the classic pixel-art threshold order.
  const BAYER8 = (() => {
    const raw = [
      0, 32, 8, 40, 2, 34, 10, 42,
      48, 16, 56, 24, 50, 18, 58, 26,
      12, 44, 4, 36, 14, 46, 6, 38,
      60, 28, 52, 20, 62, 30, 54, 22,
      3, 35, 11, 43, 1, 33, 9, 41,
      51, 19, 59, 27, 49, 17, 57, 25,
      15, 47, 7, 39, 13, 45, 5, 37,
      63, 31, 55, 23, 61, 29, 53, 21,
    ];
    const out = new Float32Array(64);
    for (let i = 0; i < 64; i++) out[i] = (raw[i] + 0.5) / 64;
    return out;
  })();

  // Cheap deterministic value noise, used to rough up the dither pattern.
  function hash2(x, y, seed) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 362437)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // Packed ABGR for direct Uint32 writes into the ImageData buffer.
  function packRGB(r, g, b) {
    return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }

  function cssRGB(css, toWhite) {
    const nums = css.match(/\d+(\.\d+)?/g);
    if (!nums) return packRGB(0, 0, 0);
    const r = +nums[0];
    const g = +nums[1];
    const b = +nums[2];
    if (!toWhite) return packRGB(r, g, b);
    return packRGB(
      Math.round(r + (255 - r) * toWhite),
      Math.round(g + (255 - g) * toWhite),
      Math.round(b + (255 - b) * toWhite)
    );
  }

  /* One block size for everything pixel-art on the page: the dissolve grid and
     the stepped card corners are cut from the same lattice. */
  function cellSizeFor(width) {
    return Math.max(6, Math.min(14, Math.round(width / 150)));
  }

  function chamferFractions(el) {
    const cs = getComputedStyle(el || stack);
    return {
      x: (parseFloat(cs.getPropertyValue("--cutx")) || 4.35) / 100,
      y: (parseFloat(cs.getPropertyValue("--cuty")) || 6.4) / 100,
    };
  }

  /* The card outline with its two chamfers quantised to the block grid, so the
     crisp card already looks like the pixel layer that replaces it. Straight
     edges stay exact — only the diagonals become staircases. `box` is in stack
     coordinates; the result is card-local, ready for clip-path. */
  function pixelChamferPolygon(box, cell) {
    const left = box.x;
    const top = box.y;
    const right = box.x + box.w;
    const bottom = box.y + box.h;
    const steps = box.cutX >= 1 && box.cutY >= 1;
    const pts = [[0, 0]]; // top-left corner, in card-local coordinates

    let px = left;
    let py = top;
    const to = (nx, ny) => {
      nx = Math.min(right, Math.max(left, nx));
      ny = Math.min(bottom, Math.max(top, ny));
      if (nx !== px || ny !== py) {
        pts.push([nx - left, ny - top]);
        px = nx;
        py = ny;
      }
    };

    // top edge, dropping a block row at a time across the top-right chamfer
    if (steps) {
      const start = right - box.cutX;
      for (let gx = Math.ceil(start / cell - 0.5); gx * cell < right; gx++) {
        const mid = (gx + 0.5) * cell;
        const lineY = top + (box.cutY * (mid - start)) / box.cutX;
        to(Math.max(left, gx * cell), py);
        to(px, (Math.floor(lineY / cell - 0.5) + 1) * cell);
        to(Math.min(right, (gx + 1) * cell), py);
      }
    }
    to(right, py);
    to(right, bottom);

    // bottom edge, climbing back up across the bottom-left chamfer
    if (steps && box.bottomCut !== false) {
      const end = left + box.cutX;
      for (let gx = Math.floor(end / cell - 0.5); gx * cell > left - cell; gx--) {
        const mid = (gx + 0.5) * cell;
        const lineY = bottom - (box.cutY * (end - mid)) / box.cutX;
        to(Math.min(right, (gx + 1) * cell), py);
        to(px, Math.ceil(lineY / cell - 0.5) * cell);
        to(Math.max(left, gx * cell), py);
      }
    }
    to(left, py);

    return pts;
  }

  /* Stamp that outline onto the real cards. Uses layout boxes (offset*), so the
     entrance animation's transform can't skew the shape. */
  function updatePixelCorners() {
    if (!cards.length) return;
    // same source of truth as the dissolve grid, so both use the same block size
    const width = stack.getBoundingClientRect().width;
    if (!width) return;

    const cell = cellSizeFor(width);
    const frac = chamferFractions();

    cards.forEach((card) => {
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      if (!w || !h) return;

      const pts = pixelChamferPolygon(
        {
          x: card.offsetLeft,
          y: card.offsetTop,
          w,
          h,
          cutX: w * frac.x,
          cutY: h * frac.y,
        },
        cell
      );

      card.style.clipPath =
        "polygon(" + pts.map((p) => p[0].toFixed(2) + "px " + p[1].toFixed(2) + "px").join(", ") + ")";
    });
  }

  updatePixelCorners();
  window.addEventListener("resize", updatePixelCorners, { passive: true });
  if (document.fonts) document.fonts.ready.then(updatePixelCorners);
  if ("ResizeObserver" in window) {
    new ResizeObserver(updatePixelCorners).observe(stack);
  }

  const PixelDissolve = (() => {
    let stackW = 1;
    let stackH = 1;
    let cutX = 0.0435;
    let cutY = 0.064;
    let geo = [];
    let cell = 10;          // one block size for the whole dissolve

    let entry = null;       // { cell, gw, gh, masks, boxes, thr }
    let imgData = null;
    let buf32 = null;

    /* Read the real geometry/colours once per dissolve, so the canvas copy of
       the stack is pixel-for-pixel where the DOM cards were. */
    function measure() {
      const rect = stack.getBoundingClientRect();
      stackW = Math.max(1, rect.width);
      stackH = Math.max(1, rect.height);

      const frac = chamferFractions();
      cutX = frac.x;
      cutY = frac.y;

      geo = cards.map((card) => {
        const r = card.getBoundingClientRect();
        const style = getComputedStyle(card);
        return {
          x: r.left - rect.left,
          y: r.top - rect.top,
          w: r.width,
          h: r.height,
          color: cssRGB(style.backgroundColor, 0),
          hot: cssRGB(style.backgroundColor, 0.42),
        };
      });

      // Fixed for the whole dissolve, so blocks keep their shape, size and
      // position from the first frame to the last — and match the card corners.
      cell = cellSizeFor(stackW);
    }

    /* The stack's silhouette as a per-card bitmask plus ONE dither threshold
       per cell. Built on the CPU in a throwaway low-res canvas, so no
       full-size pixel work ever happens. */
    function build(cellSize) {
      const gw = Math.max(2, Math.ceil(stackW / cellSize));
      const gh = Math.max(2, Math.ceil(stackH / cellSize));
      const size = gw * gh;

      const off = document.createElement("canvas");
      off.width = gw;
      off.height = gh;
      const octx = off.getContext("2d", { willReadFrequently: true });

      const masks = new Array(geo.length);
      const boxes = new Array(geo.length);

      for (let i = 0; i < geo.length; i++) {
        const c = geo[i];
        octx.setTransform(1, 0, 0, 1, 0, 0);
        octx.clearRect(0, 0, gw, gh);
        octx.setTransform(1 / cellSize, 0, 0, 1 / cellSize, 0, 0);

        // exactly the DOM card's shape: the chamfered outline, square corners
        const cx = c.w * cutX;
        const cy = c.h * cutY;
        octx.beginPath();
        octx.moveTo(c.x, c.y);
        octx.lineTo(c.x + c.w - cx, c.y);
        octx.lineTo(c.x + c.w, c.y + cy);
        octx.lineTo(c.x + c.w, c.y + c.h);
        octx.lineTo(c.x + cx, c.y + c.h);
        octx.lineTo(c.x, c.y + c.h - cy);
        octx.closePath();
        octx.fillStyle = "#fff";
        octx.fill();

        const px = octx.getImageData(0, 0, gw, gh).data;
        const mask = new Uint8Array(size);

        let x0 = gw;
        let x1 = -1;
        let y0 = gh;
        let y1 = -1;

        for (let y = 0; y < gh; y++) {
          const row = y * gw;
          for (let x = 0; x < gw; x++) {
            if (px[(row + x) * 4 + 3] > 127) {
              mask[row + x] = 1;
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y0 === gh) y0 = y;
              y1 = y;
            }
          }
        }

        masks[i] = mask;
        boxes[i] = x1 >= 0 ? { x0, y0, x1, y1 } : null;
      }

      // ONE threshold field for the whole stack, in stack coordinates: every
      // layer burns away on exactly the same pixels at exactly the same moment,
      // so the stack reads as a single object instead of four peeling sheets.
      // Mostly a radial sweep out from the middle, textured by the ordered
      // dither with a little noise. Weights sum to 1, so progress maps 0..1.
      const thr = new Uint8Array(size);
      const ccx = gw / 2;
      const ccy = gh / 2;
      const maxR = Math.max(1, Math.hypot(ccx, ccy));

      for (let y = 0; y < gh; y++) {
        const row = y * gw;
        for (let x = 0; x < gw; x++) {
          const radial = Math.min(1, Math.hypot(x - ccx, y - ccy) / maxR);
          const t =
            0.72 * radial +
            0.22 * BAYER8[((y & 7) << 3) | (x & 7)] +
            0.06 * hash2(x, y, 977);
          thr[row + x] = (t * 255) | 0;
        }
      }

      return { cell: cellSize, gw, gh, masks, boxes, thr };
    }

    /* Built once, on the dissolve's first frame: from then on the blocks keep
       the same shape, size and position for the whole animation. */
    function prepare() {
      entry = build(cell);
      dissolveCanvas.width = entry.gw;
      dissolveCanvas.height = entry.gh;
      imgData = dctx.createImageData(entry.gw, entry.gh);
      buf32 = new Uint32Array(imgData.data.buffer);
    }

    function render(progress) {
      if (!entry) prepare();

      const gw = entry.gw;
      buf32.fill(0);

      const cut = progress * 255;
      if (cut < 255) {
        const hotEdge = cut + 8; // cells about to vanish glow a touch
        const thr = entry.thr;

        // back -> front, same as the DOM stacking order. Every layer is cut by
        // the same threshold, so the colour bands only show where a bigger card
        // reaches past the smaller one on top of it.
        for (let i = 0; i < geo.length; i++) {
          const box = entry.boxes[i];
          if (!box) continue;

          const c = geo[i];
          const mask = entry.masks[i];

          for (let y = box.y0; y <= box.y1; y++) {
            const start = y * gw + box.x0;
            const end = start + (box.x1 - box.x0);
            for (let idx = start; idx <= end; idx++) {
              if (!mask[idx]) continue;
              const t = thr[idx];
              if (t <= cut) continue;
              buf32[idx] = t <= hotEdge ? c.hot : c.color;
            }
          }
        }
      }

      dctx.putImageData(imgData, 0, 0);
    }

    return {
      begin() {
        entry = null;
        imgData = null;
        buf32 = null;
        measure();
      },
      frame(progress) {
        render(progress);
      },
      end() {
        // dropping the bitmap frees the pixel work immediately
        dissolveCanvas.width = 0;
        dissolveCanvas.height = 0;
        entry = null;
        imgData = null;
        buf32 = null;
      },
    };
  })();

  // the whole stack dissolves as one object, so there is a single progress
  const DISSOLVE_DURATION = reduceMotion ? 0.5 : 1.5;

  let dissolveFrame = 0;

  const smoothstep = (x) => x * x * (3 - 2 * x);

  function startDissolve() {
    body.classList.remove("phase-in", "phase-out");
    body.classList.add("phase-dissolve");

    PixelDissolve.begin();

    const start = performance.now();

    function tick(now) {
      const elapsed = (now - start) / 1000;
      const raw = elapsed / DISSOLVE_DURATION;

      if (raw >= 1) {
        PixelDissolve.frame(1);
        finishDissolve();
        return;
      }

      PixelDissolve.frame(smoothstep(raw));
      dissolveFrame = requestAnimationFrame(tick);
    }

    dissolveFrame = requestAnimationFrame(tick);
  }

  function finishDissolve() {
    cancelAnimationFrame(dissolveFrame);
    dissolveFrame = 0;
    PixelDissolve.end();

    body.classList.remove("phase-dissolve");
    body.classList.add("phase-out");
  }

  // one-shot: the layers fade in (0 → 1.6s), hold a couple of seconds, then
  // burn away. Nothing replays after that.
  const ENTRANCE_END = reduceMotion ? 0 : 1600;
  const HOLD = reduceMotion ? 1400 : 2400;
  setTimeout(startDissolve, ENTRANCE_END + HOLD);

  /* ========================================================================
     3 — Pixel ball field
     ======================================================================== */

  const COLORS = {
    highlight: "#ffd8ea",
    light: "#ff96ca",
    base: "#f45ba4",
    dark: "#cd3a86",
    rim: "#8f1f59",
    lime: "#c8f354",
    purple: "#7449ef",
  };

  const view = { w: 0, h: 0, dpr: 1, cell: 10 };
  const ball = { x: 0, y: 0, vx: 0, vy: 0 };
  const pointer = { x: 0, y: 0, active: false, last: -1e9 };
  const trail = [];
  const particles = [];
  const stars = [];
  let trailClock = 0;

  const BAYER = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];

  const snap = (v, cell) => Math.round(v / cell) * cell;

  function resize() {
    // The field is a fixed layer over the whole page now, so the dust and the
    // ball are always on screen, in every section.
    view.w = window.innerWidth;
    view.h = window.innerHeight;
    view.dpr = Math.min(2, window.devicePixelRatio || 1);
    view.cell = Math.max(7, Math.min(13, Math.round(Math.min(view.w, view.h) / 88)));

    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

    if (!ball.x) {
      ball.x = view.w * 0.5;
      ball.y = view.h * 0.5;
    }

    buildStars();
  }

  function buildStars() {
    stars.length = 0;
    const count = Math.round((view.w * view.h) / 32000);
    const palette = [COLORS.base, COLORS.light, COLORS.lime, COLORS.purple, "#ffffff", COLORS.base];

    for (let i = 0; i < count; i++) {
      stars.push({
        x: snap(Math.random() * view.w, view.cell),
        y: snap(Math.random() * view.h, view.cell),
        a: 0.035 + Math.random() * 0.15,
        speed: 0.35 + Math.random() * 1.6,
        phase: Math.random() * Math.PI * 2,
        color: palette[Math.floor(Math.random() * palette.length)],
      });
    }
  }

  function idleTarget(now) {
    const t = (now / 1000) * (reduceMotion ? 0.25 : 1);
    return {
      x: view.w * (0.5 + 0.4 * Math.sin(t * 0.47 + 0.8)),
      y: view.h * (0.5 + 0.36 * Math.sin(t * 0.71 + 2.1)),
    };
  }

  function update(dt, now) {
    let target;

    if (pointer.active && now - pointer.last < 4500) {
      target = pointer;
    } else {
      target = idleTarget(now);
    }

    const pad = view.cell * 7;
    const floorY = ballFloor();

    // Keep the follow target on screen, then stop it at the wall.
    target = {
      x: Math.min(view.w - pad, Math.max(pad, target.x)),
      y: Math.min(view.h - pad, Math.max(pad, target.y)),
    };
    if (floorY < view.h) target.y = Math.min(target.y, floorY);

    // Springy follow — a little overshoot keeps it playful.
    const k = 120;
    const damping = 15;
    ball.vx += ((target.x - ball.x) * k - ball.vx * damping) * dt;
    ball.vy += ((target.y - ball.y) * k - ball.vy * damping) * dt;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    ball.x = Math.min(view.w - pad, Math.max(pad, ball.x));
    ball.y = Math.min(view.h - pad, Math.max(pad, ball.y));
    // the wall wins: once the page scrolls past it the ball leaves with the
    // section instead of riding along into the next one
    if (floorY < view.h) ball.y = Math.min(ball.y, floorY);

    // Trail samples
    trailClock += dt;
    if (trailClock >= 0.03) {
      trailClock = 0;
      trail.push({ x: ball.x, y: ball.y, age: 0 });
      if (trail.length > 18) trail.shift();
    }
    for (let i = trail.length - 1; i >= 0; i--) {
      trail[i].age += dt;
      if (trail[i].age > 0.46) trail.splice(i, 1);
    }

    // Sparks
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) {
        particles.splice(i, 1);
        continue;
      }
      p.vy += 340 * dt;
      p.vx *= Math.max(0, 1 - 1.9 * dt);
      p.vy *= Math.max(0, 1 - 1.1 * dt);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  /* One pixel-light routine for the whole page (the ball's halo and the light
     the ball throws on the keyword blocks). Squares sit on a cell lattice and
     nearly touch; a square is only drawn when the whole of it fits inside the
     radius, so the light is never sliced by its own edge. Brightness is handed
     in as a function of the normalised distance (0 at the centre, 1 at the rim)
     so each caller can shape its own falloff. */
  function drawSquareLight(g, cx, cy, radius, cell, size, color, alphaFor) {
    const halfDiag = Math.SQRT2 * (size / 2);
    const inset = (cell - size) / 2;
    const minX = Math.floor((cx - radius) / cell) * cell;
    const maxX = cx + radius;
    const minY = Math.floor((cy - radius) / cell) * cell;
    const maxY = cy + radius;

    g.fillStyle = color;

    for (let gy = minY; gy < maxY; gy += cell) {
      for (let gx = minX; gx < maxX; gx += cell) {
        const d = Math.hypot(gx + cell / 2 - cx, gy + cell / 2 - cy);
        if (d + halfDiag > radius) continue;

        const alpha = alphaFor(d / radius, gx, gy, cell);
        if (alpha <= 0) continue;

        g.globalAlpha = alpha;
        g.fillRect(gx + inset, gy + inset, size, size);
      }
    }

    g.globalAlpha = 1;
  }

  // breaks the outermost band into pixels instead of a hard ring
  function bayerSkip(t, from, gx, gy, cell) {
    if (t <= from) return false;
    // the lattice can run past the left/top edge, so both indices wrap positively
    const ix = ((((gx / cell) | 0) % 4) + 4) % 4;
    const iy = ((((gy / cell) | 0) % 4) + 4) % 4;
    const thr = (BAYER[iy][ix] + 0.5) / 16;
    return thr > (1 - t) / (1 - from);
  }

  // the size of the ball's glow — the keyword blocks use the very same one
  function haloRadius() {
    return (reduceMotion ? 8 : 11) * view.cell;
  }

  function drawHalo(cx, cy) {
    const gx = snap(cx, view.cell);
    const gy = snap(cy, view.cell);
    const cell = view.cell;

    // squares butt up against each other: no gap in the lattice, and the light
    // steps down in bands as it gets further from the ball
    drawSquareLight(ctx, gx, gy, haloRadius(), cell, cell, COLORS.base, (t, sx, sy, c) => {
      // the light runs all the way in: the ball's own dithered rim leaves gaps,
      // and an empty ring there read as black pixels hugging the ball
      if (bayerSkip(t, 0.8, sx, sy, c)) return 0;
      if (t < 0.38) return 0.26;
      if (t < 0.52) return 0.225;
      if (t < 0.64) return 0.175;
      if (t < 0.76) return 0.13;
      if (t < 0.88) return 0.09;
      return 0.055;
    });
  }

  function drawPixelBall(cx, cy, radius, alpha, angle, stretch, isTrail) {
    const gx = snap(cx, view.cell);
    const gy = snap(cy, view.cell);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const a = radius * (1 + stretch);
    const b = radius * (1 - stretch * 0.55);
    const reach = Math.ceil(a) + 1;
    const inner = isTrail ? 0.58 : 0.8;

    for (let oy = -reach; oy <= reach; oy++) {
      for (let ox = -reach; ox <= reach; ox++) {
        const rx = ox * cos + oy * sin;
        const ry = -ox * sin + oy * cos;
        const d = Math.sqrt((rx / a) * (rx / a) + (ry / b) * (ry / b));
        if (d > 1.08) continue;

        let cellAlpha = alpha;

        // dithered, pixel-stepped edge
        if (d > inner) {
          const edge = (1.08 - d) / (1.08 - inner);
          const threshold =
            (BAYER[((ox % 4) + 4) % 4][((oy % 4) + 4) % 4] + 0.5) / 16;
          if (edge < threshold) continue;
          cellAlpha *= Math.min(1, 0.5 + edge * 0.5);
        }

        let color;
        if (!isTrail && d > 0.9) {
          color = COLORS.rim;
        } else {
          const shade = (rx / a) * 0.62 + (ry / b) * 0.72;
          if (isTrail) color = shade < 0 ? COLORS.dark : COLORS.base;
          else if (shade < -0.58) color = COLORS.highlight;
          else if (shade < 0.05) color = COLORS.light;
          else if (shade < 0.55) color = COLORS.base;
          else color = COLORS.dark;
        }

        ctx.globalAlpha = cellAlpha;
        ctx.fillStyle = color;
        ctx.fillRect(gx + ox * view.cell, gy + oy * view.cell, view.cell, view.cell);
      }
    }
  }

  function draw(now) {
    ctx.clearRect(0, 0, view.w, view.h);

    // ambient pixel dust — brightens as the ball passes by
    for (const s of stars) {
      const twinkle = 0.55 + 0.45 * Math.sin(now * 0.001 * s.speed + s.phase);
      const dx = s.x - ball.x;
      const dy = s.y - ball.y;
      const proximity = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 240);
      ctx.globalAlpha = Math.min(1, s.a * twinkle + proximity * 0.18);
      ctx.fillStyle = s.color;
      ctx.fillRect(s.x, s.y, view.cell, view.cell);
    }

    const speed = Math.hypot(ball.vx, ball.vy);
    const stretch =
      Math.min(0.22, speed / 2200) * (reduceMotion ? 0.3 : 1);
    const angle = Math.atan2(ball.vy, ball.vx);

    drawHalo(ball.x, ball.y);

    if (!reduceMotion) {
      for (const t of trail) {
        const life = 1 - t.age / 0.46;
        drawPixelBall(t.x, t.y, 3.2 * life + 0.6, 0.32 * life * life, 0, 0, true);
      }
    }

    drawPixelBall(ball.x, ball.y, 4.6, 1, angle, stretch, false);

    for (const p of particles) {
      const life = 1 - p.age / p.life;
      ctx.globalAlpha = Math.min(1, life * 1.4);
      ctx.fillStyle = p.color;
      ctx.fillRect(
        snap(p.x, view.cell),
        snap(p.y, view.cell),
        view.cell,
        view.cell
      );
    }

    ctx.globalAlpha = 1;
  }

  function burst(x, y) {
    if (reduceMotion) return;
    const count = 12;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.7;
      const sp = 70 + Math.random() * 250;
      particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 70,
        age: 0,
        life: 0.45 + Math.random() * 0.45,
        color:
          i % 4 === 0 ? COLORS.lime : i % 3 === 0 ? COLORS.highlight : COLORS.base,
      });
    }
  }

  const infoSection = document.getElementById("info");

  /* A wall for the ball, in document coordinates: it cannot travel past the
     bottom edge of the last keyword block, so it never follows the cursor into
     the section below. Measured by measureBallFloor() further down. */
  let ballFloorDoc = Infinity;

  function ballFloor() {
    const scrollY = window.scrollY || window.pageYOffset || 0;
    return ballFloorDoc - scrollY - view.cell * 1.5;
  }

  let lastTime = performance.now();

  let loopFailed = false;
  let haloClock = 0;

  function loop(now) {
    // queue the next frame first: one bad frame must never freeze the field
    requestAnimationFrame(loop);

    const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
    lastTime = now;

    try {
      update(dt, now);
      draw(now);
      reflectLight();

      // the name's field breathes, but only once the cards are gone
      if (now - haloClock > 40 && body.classList.contains("phase-out")) {
        haloClock = now;
        paintHeroHalo(now);
      }
    } catch (err) {
      if (!loopFailed) {
        loopFailed = true;
        console.error("pixel field frame failed", err);
      }
    }
  }

  // viewport coordinates: the field is fixed, so clientX/Y are canvas coords
  function trackPointer(e) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.active = true;
    pointer.last = performance.now();
  }

  window.addEventListener("pointermove", trackPointer, { passive: true });

  window.addEventListener("pointerdown", (e) => {
    trackPointer(e);
    burst(e.clientX, e.clientY);
  }, { passive: true });

  window.addEventListener("resize", resize, { passive: true });

  resize();
  requestAnimationFrame(loop);

  /* ========================================================================
     4 — Keyword lines that fill the section
     ------------------------------------------------------------------------
     The mockup's proportions are fixed, and every part of them scales with the
     type: each line steps right by 9.5% of the usable width, and the longest
     line ("DATA VISUALIZATION") is sized to run from the last step all the way
     to the right edge. So one measurement per resize is enough to solve for
     the font size that makes the block span the screen.
     ======================================================================== */

  const keywordsEl = document.getElementById("keywords");
  const kwLines = keywordsEl ? Array.from(keywordsEl.querySelectorAll(".kw")) : [];
  const kwBlocks = keywordsEl ? Array.from(keywordsEl.querySelectorAll(".kw-block")) : [];

  /* One small canvas per block for the light. Drawn in whole cells so a square
     is either lit or absent — never clipped by the edge of the light. */
  const kwGlows = kwBlocks.map((block) => {
    const canvas = document.createElement("canvas");
    canvas.className = "kw-glow";
    canvas.setAttribute("aria-hidden", "true");
    block.insertBefore(canvas, block.firstChild);
    return {
      block,
      canvas,
      ctx: canvas.getContext("2d"),
      w: 0,
      h: 0,
      cell: 12,
      lit: false,
    };
  });

  const KW_STEP = 0.095;   // horizontal step between lines, share of usable width
  const KW_LEADING = 1.15; // line-height, matches style.css
  const KW_FILL = 0.94;    // how much of the available height the block may use
  // the longest block stops short of the right edge (--kw-fill, tunable in CSS)

  const KW_WIDTH_FILL = 0.86; // fallback when --kw-fill is missing
  const KW_TEXT_SCALE = 0.7;  // fallback when --kw-text-scale is missing

  let kwFrame = 0;

  function kwTextWidth(el) {
    // clone the block as-is: its padding is in em, so it scales with the probe
    // font size and stays part of the measured footprint
    const probe = el.cloneNode(true);
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:absolute;left:-99999px;top:0;width:max-content;max-width:none;" +
      "visibility:hidden;pointer-events:none;white-space:nowrap;font-size:100px;";
    // appended next to the block so every inherited type property matches
    (el.parentElement || keywordsEl).appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width || 1;
  }

  function fitKeywords() {
    if (!keywordsEl || kwLines.length < 2) return;

    const cs = getComputedStyle(keywordsEl);
    const availW =
      keywordsEl.clientWidth -
      parseFloat(cs.paddingLeft) -
      parseFloat(cs.paddingRight);
    const availH =
      keywordsEl.clientHeight -
      parseFloat(cs.paddingTop) -
      parseFloat(cs.paddingBottom);
    if (!availW || !availH) return;

    const step = availW * KW_STEP;
    const lastIndent = step * (kwLines.length - 1);

    // widest block at 100px decides the horizontal fit
    let widest = 0;
    for (const block of kwBlocks) widest = Math.max(widest, kwTextWidth(block));

    const fill =
      parseFloat(cs.getPropertyValue("--kw-fill")) || KW_WIDTH_FILL;
    const fitWidth = (100 * (availW - lastIndent) * fill) / widest;
    const fitHeight = (availH * KW_FILL) / (kwLines.length * KW_LEADING);
    let size = Math.max(14, Math.min(fitWidth, fitHeight));

    applyKwSize(size, step);

    // Safety pass: the maths above is exact for the probe, but rounding and the
    // real text run can still push a block past the page margin. Measure what
    // actually rendered and shrink until every block sits inside the padding.
    for (let i = 0; i < 3; i++) {
      const over = kwOverflow(cs);
      if (over <= 0.5) break;
      size *= Math.max(0.8, 1 - over / Math.max(1, availW)) * 0.998;
      applyKwSize(size, step);
    }
  }

  /* Two-phase sizing: lay the blocks out at the fitted size so their boxes are
     the reference geometry, freeze those boxes, then shrink the type inside
     them. So a smaller type never shrinks the block. */
  function applyKwSize(size, step) {
    for (const block of kwBlocks) {
      block.style.width = "";
      block.style.height = "";
    }

    const textScale =
      parseFloat(getComputedStyle(keywordsEl).getPropertyValue("--kw-text-scale")) ||
      KW_TEXT_SCALE;

    keywordsEl.style.setProperty("--kw-size", size.toFixed(2) + "px");
    keywordsEl.style.setProperty("--kw-text-size", size.toFixed(2) + "px");
    keywordsEl.style.setProperty("--kw-step", step.toFixed(2) + "px");

    // phase 1 done: remember the boxes, then shrink the type inside them.
    // Every chip gets the same size — the widest block's width, the tallest
    // block's height — so the staircase is made of identical boxes.
    let boxW = 0;
    let boxH = 0;
    for (const block of kwBlocks) {
      boxW = Math.max(boxW, block.offsetWidth);
      boxH = Math.max(boxH, block.offsetHeight);
    }
    for (const block of kwBlocks) {
      block.style.width = boxW + "px";
      block.style.height = boxH + "px";
    }

    keywordsEl.style.setProperty(
      "--kw-text-size",
      (size * textScale).toFixed(2) + "px"
    );

    // the corners are cut from a lattice sized by the block, so restep after
    // every refit
    stepKeywordCorners();
  }

  // how far the widest block pokes past the right content edge, in px
  function kwOverflow(cs) {
    const box = keywordsEl.getBoundingClientRect();
    const limit = box.right - parseFloat(cs.paddingRight);
    let over = 0;
    for (const block of kwBlocks) {
      const r = block.getBoundingClientRect();
      over = Math.max(over, r.right - limit);
    }
    return over;
  }

  /* Same treatment as the name cards: the two facing corners are chamfered and
     quantised to a block lattice, so the diagonal reads as a pixel staircase
     instead of a smooth cut. */
  function stepKeywordCorners() {
    for (const block of kwBlocks) {
      const w = block.offsetWidth;
      const h = block.offsetHeight;
      if (!w || !h) continue;

      const cell = Math.max(4, Math.round(h / 8));
      const cut = Math.max(cell, Math.round((h * 0.32) / cell) * cell);
      const pts = pixelChamferPolygon(
        { x: 0, y: 0, w, h, cutX: cut, cutY: cut },
        cell
      );

      block.style.clipPath =
        "polygon(" +
        pts.map((p) => p[0].toFixed(1) + "px " + p[1].toFixed(1) + "px").join(", ") +
        ")";

      // the light is drawn on the same lattice as the corners
      const glow = kwGlows[kwBlocks.indexOf(block)];
      if (glow) {
        glow.cell = cell;
        sizeGlowCanvas(glow, w, h);
      }
    }

    measureBallFloor();
  }

  /* The wall sits on the bottom edge of the last keyword block — "DATA
     VISUALIZATION" — so the ball may roam the hero and the keywords and no
     further. Kept in document space so it scrolls with the section. */
  function measureBallFloor() {
    const last = kwBlocks[kwBlocks.length - 1];
    if (!last) return;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    ballFloorDoc = last.getBoundingClientRect().bottom + scrollY;
  }

  function sizeGlowCanvas(glow, w, h) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    glow.w = w;
    glow.h = h;
    glow.canvas.width = Math.round(w * dpr);
    glow.canvas.height = Math.round(h * dpr);
    glow.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    glow.lit = false; // force a redraw at the new size
  }

  function queueKeywordFit() {
    cancelAnimationFrame(kwFrame);
    kwFrame = requestAnimationFrame(fitKeywords);
  }

  fitKeywords();
  window.addEventListener("load", fitKeywords);
  window.addEventListener("resize", queueKeywordFit, { passive: true });
  if (document.fonts) document.fonts.ready.then(fitKeywords);
  if ("ResizeObserver" in window && keywordsEl) {
    new ResizeObserver(queueKeywordFit).observe(keywordsEl);
  }

  /* ========================================================================
     5 — The ball lights up the keyword blocks
     ------------------------------------------------------------------------
     Each block owns a canvas layered over its colour. The light is painted as
     individual squares on the block's own lattice: a square is drawn only when
     the whole of it falls inside the light radius, so nothing is ever sliced in
     half by the edge. The type stays black on top.
     ======================================================================== */



  /* The blocks float, so their boxes are read live — four rects a frame is far
     cheaper than tracking an animation offset by hand. */
  function reflectLight() {
    if (!kwBlocks.length) return;

    for (let i = 0; i < kwBlocks.length; i++) {
      const glow = kwGlows[i];
      if (!glow || !glow.w) continue;

      const box = kwBlocks[i].getBoundingClientRect();
      const radius = haloRadius();

      // distance from the ball to the block's box, not to a point
      const dx = Math.max(box.left - ball.x, 0, ball.x - box.right);
      const dy = Math.max(box.top - ball.y, 0, ball.y - box.bottom);
      const reach = Math.hypot(dx, dy);

      if (reach > radius) {
        if (glow.lit) {
          glow.ctx.clearRect(0, 0, glow.w, glow.h);
          glow.lit = false;
        }
        continue;
      }

      drawGlow(glow, ball.x - box.left, ball.y - box.top, radius);
      glow.lit = true;
    }
  }

  /* The same light the ball gives off, in white over the block colour: same
     cell size, same reach, squares butted together, and only slightly opaque so
     the block's own colour still leads. */
  function drawGlow(glow, bx, by) {
    const cell = view.cell || 10;

    glow.ctx.clearRect(0, 0, glow.w, glow.h);

    drawSquareLight(
      glow.ctx,
      bx,
      by,
      haloRadius(),
      cell,
      cell,
      "#ffffff",
      (t, gx, gy, c) => {
        if (bayerSkip(t, 0.72, gx, gy, c)) return 0;
        if (t < 0.42) return 0.44;
        if (t < 0.62) return 0.34;
        if (t < 0.78) return 0.24;
        if (t < 0.9) return 0.16;
        return 0.09;
      }
    );
  }

  reflectLight();

  /* ========================================================================
     6 — The green field behind the name
     ------------------------------------------------------------------------
     Drawn as a disc of pixel cells on a canvas instead of a CSS gradient, so its
     squares butt up against each other exactly like the ball's light — banded
     brightness, dithered rim, nothing soft.
     ======================================================================== */

  const haloCanvas = stack.querySelector(".halo");
  const haloCtx = haloCanvas ? haloCanvas.getContext("2d") : null;

  function drawPixelEllipse(g, cx, cy, rx, ry, cell, color, alphaFor) {
    const grow = (Math.SQRT2 * (cell / 2)) / Math.min(rx, ry);
    const minX = Math.floor((cx - rx) / cell) * cell;
    const maxX = cx + rx;
    const minY = Math.floor((cy - ry) / cell) * cell;
    const maxY = cy + ry;

    g.fillStyle = color;

    for (let gy = minY; gy < maxY; gy += cell) {
      for (let gx = minX; gx < maxX; gx += cell) {
        const px = gx + cell / 2 - cx;
        const py = gy + cell / 2 - cy;
        const t = Math.hypot(px / rx, py / ry);

        // whole squares only: nothing on the rim gets sliced
        if (t + grow > 1) continue;

        const alpha = alphaFor(t, gx, gy, cell);
        if (alpha <= 0) continue;

        g.globalAlpha = alpha;
        g.fillRect(gx, gy, cell, cell);
      }
    }

    g.globalAlpha = 1;
  }

  /* Size the bitmap once per layout change; the painting happens every frame so
     the field can breathe. */
  let haloW = 0;
  let haloH = 0;
  let haloCell = 8;

  function sizeHeroHalo() {
    if (!haloCanvas || !haloCtx) return false;
    const w = haloCanvas.clientWidth;
    const h = haloCanvas.clientHeight;
    if (!w || !h) return false;

    if (w !== haloW || h !== haloH) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      haloCanvas.width = Math.round(w * dpr);
      haloCanvas.height = Math.round(h * dpr);
      haloCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      haloW = w;
      haloH = h;
    }
    haloCell = cellSizeFor(stack.getBoundingClientRect().width);
    return true;
  }

  /* Slow flicker per cell, like embers: two noise fields two tenths of a second
     apart, cross-faded, so the squares shimmer instead of strobing. */
  function emberNoise(i, j, now) {
    const phase = now * 0.0022;
    const step = Math.floor(phase);
    const f = phase - step;
    const a = hash2(i, j, step);
    const b = hash2(i, j, step + 1);
    return a + (b - a) * f;
  }

  function paintHeroHalo(now) {
    if (!sizeHeroHalo()) return;

    const w = haloW;
    const h = haloH;

    // breathing: the field swells and dims a touch
    const breath = 1 + 0.045 * Math.sin(now * 0.00085);
    const intensity = 0.92 + 0.08 * Math.sin(now * 0.0012 + 1.1);

    haloCtx.clearRect(0, 0, w, h);

    drawPixelEllipse(
      haloCtx,
      w / 2,
      h / 2,
      (w / 2) * breath,
      (h / 2) * breath,
      haloCell,
      COLORS.lime,
      (t, gx, gy, c) => {
        if (bayerSkip(t, 0.72, gx, gy, c)) return 0;

        // 10% of light at the very centre, stepping down to 2% at the rim
        let base;
        if (t < 0.45) base = 0.1;
        else if (t < 0.62) base = 0.08;
        else if (t < 0.78) base = 0.06;
        else if (t < 0.9) base = 0.04;
        else base = 0.02;

        const ember = 0.82 + 0.36 * emberNoise((gx / c) | 0, (gy / c) | 0, now);

        // the breathing and flicker only ever dim; the centre holds 10% at most
        return Math.min(0.1, base * intensity * ember);
      }
    );
  }

  // one paint when the page settles, then the ball's loop keeps it alive
  function drawHeroHalo() {
    paintHeroHalo(performance.now());
  }

  drawHeroHalo();
  window.addEventListener("resize", drawHeroHalo, { passive: true });
  window.addEventListener("load", drawHeroHalo);
  if (document.fonts) document.fonts.ready.then(drawHeroHalo);

  /* ========================================================================
     7 — Information section corners
     ------------------------------------------------------------------------
     The same pixel-stepped chamfer as the name cards, stamped onto the info
     stack's layers so the two sections share one lattice.
     ======================================================================== */

  const infoStack = infoSection ? infoSection.querySelector(".info-stack") : null;
  const infoFrames = infoStack ? Array.from(infoStack.querySelectorAll(".frame")) : [];

  function stepInfoCorners() {
    if (!infoStack || !infoFrames.length) return;
    const width = infoStack.getBoundingClientRect().width;
    if (!width) return;

    const cell = cellSizeFor(width);
    const frac = chamferFractions(infoStack);

    for (const frame of infoFrames) {
      const w = frame.offsetWidth;
      const h = frame.offsetHeight;
      if (!w || !h) continue;

      const pts = pixelChamferPolygon(
        {
          x: frame.offsetLeft,
          y: frame.offsetTop,
          w,
          h,
          cutX: w * frac.x,
          cutY: h * frac.y,
          // only the top-right corner is cut here: the info panel has a square
          // bottom-left corner
          bottomCut: false,
        },
        cell
      );

      frame.style.clipPath =
        "polygon(" +
        pts.map((p) => p[0].toFixed(1) + "px " + p[1].toFixed(1) + "px").join(", ") +
        ")";
    }
  }

  /* The hairline between the columns runs from the top of the sidebar down to
     the bottom of the bio text, so it stops where the words stop. */
  const infoCopy = infoStack
    ? infoStack.querySelector(".info-copy")
    : null;
  const infoSide = infoStack
    ? infoStack.querySelector(".info-side")
    : null;
  const infoCard = infoStack
    ? infoStack.querySelector(".info-card")
    : null;

  function sizeInfoDivider() {
    if (!infoCopy || !infoSide || !infoCard) return;
    if (!infoSide.offsetParent) return; // hidden (single-column layout)

    const bio = infoCopy.getBoundingClientRect();
    const side = infoSide.getBoundingClientRect();
    // cover the whole sidebar, and never stop before the bio ends
    const bottom = Math.max(bio.bottom, side.bottom);
    const height = Math.max(0, bottom - side.top);

    infoCard.style.setProperty("--info-divider", height.toFixed(1) + "px");
  }

  function layoutInfo() {
    stepInfoCorners();
    sizeInfoDivider();
  }

  layoutInfo();
  window.addEventListener("load", layoutInfo);
  window.addEventListener("resize", layoutInfo, { passive: true });
  if (document.fonts) document.fonts.ready.then(layoutInfo);
  if ("ResizeObserver" in window && infoStack) {
    new ResizeObserver(layoutInfo).observe(infoStack);
  }
})();
