/* ==========================================================================
   Nataly Hernandez — Portfolio 2026
   1. Fit the display type to the card
   2. Timeline: cards in → pixel dissolve → name revealed
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

  function chamferFractions() {
    const cs = getComputedStyle(stack);
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
    if (steps) {
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

  let phase = "in";
  let dissolveFrame = 0;
  let holdTimer = 0;

  const smoothstep = (x) => x * x * (3 - 2 * x);

  function startDissolve() {
    if (phase === "dissolve" || phase === "out") return;

    phase = "dissolve";
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

    phase = "out";
    body.classList.remove("phase-in", "phase-dissolve");
    body.classList.add("phase-out");
  }

  function replay() {
    if (phase !== "out") return;
    clearTimeout(holdTimer);

    // rebuild the colour stack, then dissolve it again
    body.classList.remove("phase-in", "phase-dissolve", "phase-out");
    phase = "in";

    void stack.offsetWidth; // restart the entrance animations
    body.classList.add("phase-in");

    holdTimer = setTimeout(startDissolve, reduceMotion ? 900 : 1850);
  }

  holdTimer = setTimeout(startDissolve, reduceMotion ? 1400 : 2300);

  window.addEventListener("keydown", (e) => {
    if (phase !== "out") return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      replay();
    }
  });

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

    // Springy follow — a little overshoot keeps it playful.
    const k = 120;
    const damping = 15;
    ball.vx += ((target.x - ball.x) * k - ball.vx * damping) * dt;
    ball.vy += ((target.y - ball.y) * k - ball.vy * damping) * dt;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    const pad = view.cell * 7;
    ball.x = Math.min(view.w - pad, Math.max(pad, ball.x));
    ball.y = Math.min(view.h - pad, Math.max(pad, ball.y));

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

  function drawHalo(cx, cy) {
    const gx = snap(cx, view.cell);
    const gy = snap(cy, view.cell);
    const R = reduceMotion ? 8 : 11;

    for (let oy = -R; oy <= R; oy += 2) {
      for (let ox = -R; ox <= R; ox += 2) {
        const d = Math.sqrt(ox * ox + oy * oy) / R;
        if (d < 0.45 || d > 1) continue;
        const edge = 1 - d;
        ctx.globalAlpha = 0.03 + edge * 0.07;
        ctx.fillStyle = COLORS.base;
        ctx.fillRect(gx + ox * view.cell, gy + oy * view.cell, view.cell, view.cell);
      }
    }
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

  let lastTime = performance.now();

  function loop(now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
    lastTime = now;
    update(dt, now);
    draw(now);
    requestAnimationFrame(loop);
  }

  window.addEventListener("pointermove", (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.active = true;
    pointer.last = performance.now();
  }, { passive: true });

  window.addEventListener("pointerdown", (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.active = true;
    pointer.last = performance.now();
    burst(e.clientX, e.clientY);
    if (phase === "out") replay();
  }, { passive: true });

  window.addEventListener("resize", resize, { passive: true });

  resize();
  requestAnimationFrame(loop);
})();
