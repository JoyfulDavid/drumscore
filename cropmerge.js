/* cropmerge.js — 드럼 악보 크롭·보정 + A4 악보 조립 (브라우저용)
 * <script src="cropmerge.js"></script> 로 불러오면 window.CropMerge 가 생깁니다.
 * PDF 생성에는 jsPDF(window.jspdf.jsPDF)가 필요합니다.
 */
(function (global) {
  'use strict';

  // ===== 기본 설정 =====
  const DEFAULT_CROP = {
    maxWidth: 2400,        // 작업 폭 상한(px). 더 큰 사진은 축소해서 처리 (메모리 절약)
    // 악보 영역 검출
    paperFrac: 0.7,        // 한 줄에서 '종이색 픽셀'이 이 비율 이상이면 악보 줄로 판단 (0~1)
    paperLuma: 200,        // 종이색 판정: 밝기가 이 값 이상이고
    paperSat: 0.12,        // 채도가 이 값 이하 (흰색~크림색)
    smooth: 15,            // 밝기 평활화 폭
    mergeGap: 20,          // 이 높이(px) 이하의 어두운 틈은 같은 악보로 합침
    minHeight: 100,        // 이보다 낮은 영역은 악보로 보지 않음
    ignoreTop: 0,          // 위쪽 N px는 검출에서 제외
    ignoreBottom: 0,       // 아래쪽 N px는 검출에서 제외
    edgeTrim: 2,           // 잘라낸 경계에서 안쪽으로 더 다듬는 px (경계에 남는 어두운 줄 방지)
    // 연보라 띠 제거
    removeBand: true,
    minValue: 175,         // 최대 채널 값이 이 이상(밝은 색)
    satMin: 0.05,          // 채도 하한 (종이 흰색 제외)
    satMax: 0.5,           // 채도 상한 (색 음표머리 제외)
    minArea: 200,          // 이 픽셀 수 이상의 덩어리만 띠로 인정
    bridge: 3,             // 오선·음표가 띠를 조각낼 때 조각을 이어 붙이는 거리(px)
    grow: 2,               // 흐린 가장자리까지 제거하기 위해 넓히는 폭(px, 밝은 픽셀에만 적용)
    growMinLuma: 170,      // 넓힐 때 이 밝기 이상인 픽셀만 포함 (어두운 오선·음표 보호)
    samplePx: 12,          // 채울 색을 샘플링할 좌우 폭(px)
    unblend: true,         // 띠 아래로 비치는 오선·음표의 색 번짐을 원래 색으로 되돌림
    overlayAlpha: 0.22,    // 띠의 덧칠 농도 (샘플 캡처 측정값 0.2~0.25). 띠·종이 색은 이미지마다 자동 측정
    neutralTol: 40,        // 복원한 픽셀의 색 차이(최대-최소 채널)가 이 이하면 회색으로 맞춤 (오선·글자는 무채색이므로)
    restoreTol: 28,        // 띠 아래 연한 오선·글자 복원: 역산한 색이 종이색과 이만큼 이상 다르면 '내용'으로 보고 살림
    tintRatio: 0.5,        // 색 번짐 판정 허용치: 띠가 만드는 색 치우침의 이 비율 이내인 픽셀만 되돌림
    debug: false,          // true면 띠 마스크 이미지를 함께 반환
    // 배경 순백색화
    whitenPaper: true,     // 이 이미지의 종이색을 측정해 순백(255)으로 맞춤
    whiteLevel: 0.95,      // 종이색의 이 비율 이상인 밝은 픽셀은 모두 순백으로
    // 밝기 보정
    brighten: true,
    lumaStart: 190,        // 이 밝기 이상인 픽셀만 밝게
    // 중간 결과 형식 (PNG = 무손실)
    outType: 'image/png',
    jpegQuality: 0.96,
  };

  const DEFAULT_COMPOSE = {
    dpi: 150,                   // 페이지 해상도. 150: 폰 화면 캡처(FHD+)용, 300: 고해상도용. A4 픽셀 크기는 자동 계산
    marginXmm: 10, marginYmm: 10,
    minGapMm: 1, maxGapMm: 3.5, // 이미지 사이 간격 범위(mm)
    maxPerPage: 9, minPerPage: 8,
    title: '', titleSizePt: 24, titleGapMm: 4,
    fontFamily: '"Malgun Gothic","Noto Sans KR","Apple SD Gothic Neo",sans-serif',
    pageJpegQuality: 0.92,
  };

  // ===== 공통 도우미 =====
  const mmToPx = (mm, dpi) => Math.round(mm * dpi / 25.4);
  const tick = () => new Promise((r) => setTimeout(r, 0)); // 화면이 멈추지 않도록 양보

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function canvasToBlob(c, type, quality) {
    if (c.convertToBlob) return c.convertToBlob({ type, quality });
    return new Promise((res, rej) =>
      c.toBlob((b) => (b ? res(b) : rej(new Error('이미지 저장 실패'))), type, quality));
  }

  function median(arr) {
    const a = Float64Array.from(arr).sort();
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // 축소해서 처리할 때 px 단위 설정도 같은 비율로 줄임
  function scaleSettings(s, sc) {
    if (sc >= 1) return s;
    const px = (v, min) => Math.max(min || 0, Math.round(v * sc));
    return Object.assign({}, s, {
      mergeGap: px(s.mergeGap), minHeight: px(s.minHeight, 1),
      ignoreTop: px(s.ignoreTop), ignoreBottom: px(s.ignoreBottom),
      edgeTrim: s.edgeTrim > 0 ? px(s.edgeTrim, 1) : 0,
      minArea: Math.max(1, Math.round(s.minArea * sc * sc)),
      bridge: s.bridge > 0 ? px(s.bridge, 1) : 0,
      grow: s.grow > 0 ? px(s.grow, 1) : 0,
      samplePx: px(s.samplePx, 1),
    });
  }

  // ===== 코드1: 크롭·보정 =====
  function rowMeansOf(data, w, h) {
    const m = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      let sum = 0;
      let i = y * w * 4;
      for (let x = 0; x < w; x++, i += 4) {
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      m[y] = sum / w;
    }
    return m;
  }

  // 줄마다 '종이색(밝고 채도 낮은) 픽셀'의 비율(0~1). 사진·영상 화면은 이 비율이 낮다
  function paperFractionOf(data, w, h, s) {
    const f = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      let cnt = 0;
      let i = y * w * 4;
      for (let x = 0; x < w; x++, i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        if (0.299 * r + 0.587 * g + 0.114 * b >= s.paperLuma && mx - mn <= s.paperSat * mx) cnt++;
      }
      f[y] = cnt / w;
    }
    return f;
  }

  // 종이색이 가장 많이 이어지는 구간 = 악보. [위, 아래) 반환, 못 찾으면 null
  // rowMeans: 줄별 종이 비율(paperFractionOf). 이름은 호환을 위해 유지
  function findScoreRows(rowMeans, s) {
    const h = rowMeans.length;
    const k = Math.round(s.smooth) | 1;
    const half = k >> 1;
    const bright = new Uint8Array(h);
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let j = -half; j <= half; j++) {
        sum += rowMeans[Math.min(h - 1, Math.max(0, y + j))];
      }
      bright[y] = sum / k >= s.paperFrac ? 1 : 0;
    }
    for (let y = 0; y < Math.min(h, s.ignoreTop); y++) bright[y] = 0;
    for (let y = Math.max(0, h - s.ignoreBottom); y < h; y++) bright[y] = 0;

    const runs = [];
    for (let y = 0; y < h;) {
      if (!bright[y]) { y++; continue; }
      const a = y;
      while (y < h && bright[y]) y++;
      runs.push([a, y]);
    }
    if (!runs.length) return null;

    const merged = [runs[0].slice()];
    for (let i = 1; i < runs.length; i++) {
      const last = merged[merged.length - 1];
      if (runs[i][0] - last[1] <= s.mergeGap) last[1] = runs[i][1];
      else merged.push(runs[i].slice());
    }
    // 길이 × 종이 비율이 가장 큰 구간 선택 (사진 속 흰 부분이 더 길어도 종이가 많은 악보가 이김)
    const mass = (r) => { let m = 0; for (let y = r[0]; y < r[1]; y++) m += rowMeans[y]; return m; };
    let best = merged[0];
    for (const r of merged) if (mass(r) > mass(best)) best = r;

    let top = best[0];
    let bottom = best[1];
    if (bottom - top < s.minHeight) return null;
    // 평활화로 생긴 경계 오차를 원본 줄 밝기로 보정 (바깥으로 넓힌 뒤 안쪽으로 다듬음)
    while (top > s.ignoreTop && rowMeans[top - 1] >= s.paperFrac) top--;
    while (bottom < h - s.ignoreBottom && rowMeans[bottom] >= s.paperFrac) bottom++;
    while (top < bottom && rowMeans[top] < s.paperFrac) top++;
    while (bottom > top && rowMeans[bottom - 1] < s.paperFrac) bottom--;
    // 이미지 끝이 아니라 '잘라낸' 경계라면 안쪽으로 조금 더 다듬음
    if (top > 0) top += s.edgeTrim;
    if (bottom < h) bottom -= s.edgeTrim;
    if (bottom - top < 1) return null;
    return [top, bottom];
  }

  // 작은 덩어리 제거: 4방향 연결 덩어리 중 minArea 이상만 남김
  // countMask가 있으면 덩어리 안에서 countMask가 켜진 픽셀 수로 크기를 판단
  function removeSmallBlobs(mask, w, h, minArea, countMask) {
    const n = w * h;
    const out = new Uint8Array(n);
    const visited = new Uint8Array(n);
    const queue = new Int32Array(n);
    for (let start = 0; start < n; start++) {
      if (!mask[start] || visited[start]) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      visited[start] = 1;
      while (head < tail) {
        const p = queue[head++];
        const x = p % w;
        const y = (p - x) / w;
        let q;
        if (x > 0) { q = p - 1; if (mask[q] && !visited[q]) { visited[q] = 1; queue[tail++] = q; } }
        if (x < w - 1) { q = p + 1; if (mask[q] && !visited[q]) { visited[q] = 1; queue[tail++] = q; } }
        if (y > 0) { q = p - w; if (mask[q] && !visited[q]) { visited[q] = 1; queue[tail++] = q; } }
        if (y < h - 1) { q = p + w; if (mask[q] && !visited[q]) { visited[q] = 1; queue[tail++] = q; } }
      }
      let size = tail;
      if (countMask) { size = 0; for (let i = 0; i < tail; i++) size += countMask[queue[i]]; }
      if (size >= minArea) for (let i = 0; i < tail; i++) out[queue[i]] = 1;
    }
    return out;
  }

  // 마스크를 상하좌우로 n픽셀 넓힘 (allowed가 있으면 허용된 픽셀로만 확장)
  function dilate(mask, w, h, n, allowed) {
    let cur = mask;
    for (let it = 0; it < n; it++) {
      const next = cur.slice();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          if (cur[p] || (allowed && !allowed[p])) continue;
          if ((x > 0 && cur[p - 1]) || (x < w - 1 && cur[p + 1]) ||
              (y > 0 && cur[p - w]) || (y < h - 1 && cur[p + w])) next[p] = 1;
        }
      }
      cur = next;
    }
    return cur;
  }

  // 이미지 전체에서 연보라(밝고 푸른~보라 계열) 띠 찾기
  // 반환: keep = 지울(채울) 픽셀, footprint = 띠가 차지하는 범위(오선·음표 포함)
  function detectBand(data, w, h, s) {
    const n = w * h;
    const raw = new Uint8Array(n);     // 색 조건에 맞는 픽셀
    const light = new Uint8Array(n);   // 밝은 픽셀 (가장자리 확장 허용 영역)
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (0.299 * r + 0.587 * g + 0.114 * b >= s.growMinLuma) light[p] = 1;
      const mx = Math.max(r, g, b);
      if (mx < s.minValue) continue;
      if (!(b >= r - 5 && b > g + 2)) continue;
      const sat = (mx - Math.min(r, g, b)) / Math.max(mx, 1);
      if (sat >= s.satMin && sat <= s.satMax) raw[p] = 1;
    }
    // 1) 오선·음표가 띠를 여러 조각으로 가르므로, 잠시 넓혀서 이어 붙인 뒤
    //    실제 색 픽셀 수가 적은 덩어리(잡음, 작은 색 음표머리)만 버림
    const blobs = removeSmallBlobs(dilate(raw, w, h, s.bridge), w, h, s.minArea, raw);
    const keep = new Uint8Array(n);
    for (let p = 0; p < n; p++) keep[p] = raw[p] & blobs[p];   // 실제 색 조건에 맞는 픽셀만 남김
    // 이 이미지의 띠 색(띠가 종이를 덮은 색)과 종이 색을 직접 측정
    const br = []; const bg = []; const bb = [];
    const pr = []; const pg = []; const pb = [];
    for (let p = 0; p < n; p++) {
      if (!light[p]) continue;
      const i = p * 4;
      if (keep[p]) { br.push(data[i]); bg.push(data[i + 1]); bb.push(data[i + 2]); }
      else if (!blobs[p] && p % 5 === 0) { pr.push(data[i]); pg.push(data[i + 1]); pb.push(data[i + 2]); }
    }
    const bandColor = br.length ? [median(br), median(bg), median(bb)] : null;
    const paperColor = pr.length ? [median(pr), median(pg), median(pb)] : null;
    // 2) 흐린 가장자리: 밝은 픽셀에만 grow만큼 넓힘 (어두운 오선·음표는 건드리지 않음)
    return { keep: s.grow > 0 ? dilate(keep, w, h, s.grow, light) : keep, core: keep, footprint: blobs, bandColor, paperColor };
  }

  function lavenderMask(data, w, h, s) {
    return detectBand(data, w, h, s).keep;
  }

  // 띠 아래에 비치는 '연한' 오선·글자(회색 가사 등)는 띠 색과 비슷해 지우기 대상이 되기 쉽다.
  // 띠 색 픽셀을 역산(원래색 = 종이색 + (현재색 - 띠색) / (1 - a))해서, 결과가 종이색과 충분히 다르면
  // 내용으로 보고 복원하고 채우기 대상에서 뺀다. 종이색에 가까우면 그대로 두어 종이색으로 채운다.
  function restoreUnderBand(data, core, fillArr, w, h, s, bandColor, paperColor) {
    if (!bandColor || !paperColor) return 0;
    const inv = 1 / (1 - s.overlayAlpha);
    let restored = 0;
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      if (!core[p]) continue;
      let v0 = paperColor[0] + (data[i] - bandColor[0]) * inv;
      let v1 = paperColor[1] + (data[i + 1] - bandColor[1]) * inv;
      let v2 = paperColor[2] + (data[i + 2] - bandColor[2]) * inv;
      const diff = Math.max(Math.abs(v0 - paperColor[0]), Math.abs(v1 - paperColor[1]), Math.abs(v2 - paperColor[2]));
      if (diff > s.restoreTol) {
        if (Math.max(v0, v1, v2) - Math.min(v0, v1, v2) <= s.neutralTol) {   // 무채색 내용이면 색 번짐 제거
          v0 = v1 = v2 = (v0 + v1 + v2) / 3;
        }
        data[i] = v0; data[i + 1] = v1; data[i + 2] = v2;
        fillArr[p] = 0;
        restored++;
      }
    }
    return restored;
  }

  // 띠 아래의 어두운 오선·음표는 띠 색으로 물들어 보인다.
  // 띠가 '농도 a로 덧칠'된 것이라 보고 역산: 원래색 = 종이색 + (현재색 - 띠색) / (1 - a)
  // 띠색·종이색은 이미지에서 측정한 값. 띠가 만드는 색 치우침과 비슷한 픽셀(회색 오선·검은 음표)만 되돌리고,
  // 색이 다른 강조 음표(파랑·초록·빨강)와 띠 밖의 픽셀은 그대로 둔다.
  function unblendBand(data, keep, footprint, w, h, s, bandColor, paperColor) {
    if (!bandColor || !paperColor) return;
    const inv = 1 / (1 - s.overlayAlpha);
    const mB = (bandColor[0] + bandColor[1] + bandColor[2]) / 3;
    const mP = (paperColor[0] + paperColor[1] + paperColor[2]) / 3;
    const e0 = (bandColor[0] - mB) - (paperColor[0] - mP);   // 띠가 만드는 색 치우침(채도 성분)
    const e1 = (bandColor[1] - mB) - (paperColor[1] - mP);
    const e2 = (bandColor[2] - mB) - (paperColor[2] - mP);
    const tol = Math.max(6, s.tintRatio * Math.sqrt(e0 * e0 + e1 * e1 + e2 * e2));
    const tol2 = tol * tol;
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      if (!footprint[p] || keep[p]) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (0.299 * r + 0.587 * g + 0.114 * b >= s.growMinLuma) continue;   // 밝은 픽셀(종이)은 제외
      const m = (r + g + b) / 3;
      const d0 = (r - m) - e0;
      const d1 = (g - m) - e1;
      const d2 = (b - m) - e2;
      if (d0 * d0 + d1 * d1 + d2 * d2 > tol2) continue;                    // 색 치우침이 다르면 제외
      data[i] = paperColor[0] + (r - bandColor[0]) * inv;
      data[i + 1] = paperColor[1] + (g - bandColor[1]) * inv;
      data[i + 2] = paperColor[2] + (b - bandColor[2]) * inv;
    }
  }

  // 마스크 영역을 같은 줄 좌우의 '종이색에 가까운 픽셀' 중앙값으로 채움.
  // 음표가 빽빽한 줄처럼 주변에 밝은 픽셀이 없으면 이미지 전체의 종이 색을 씀
  function fillMask(data, mask, w, h, n, minLuma) {
    const lim = minLuma === undefined ? 170 : minLuma;
    const lumaAt = (i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

    // 이미지 전체의 종이 색 (마스크 밖의 밝은 픽셀을 듬성듬성 샘플링)
    const pr = []; const pg = []; const pb = [];
    for (let p = 0; p < w * h; p += 7) {
      if (mask[p]) continue;
      const i = p * 4;
      if (lumaAt(i) >= lim) { pr.push(data[i]); pg.push(data[i + 1]); pb.push(data[i + 2]); }
    }
    const paper = pr.length ? [median(pr), median(pg), median(pb)] : [255, 255, 255];
    const PAPER_TOL = 24;

    for (let y = 0; y < h; y++) {
      const row = y * w;
      let x = 0;
      while (x < w) {
        if (!mask[row + x]) { x++; continue; }
        const a = x;
        while (x < w && mask[row + x]) x++;
        const b = x - 1;
        const rs = []; const gs = []; const bs = [];
        const collect = (lo, hi) => {
          for (let xx = lo; xx < hi; xx++) {
            if (mask[row + xx]) continue;
            const i = (row + xx) * 4;
            // 종이색에 가까운 픽셀만 샘플로 사용 (어두운 음표·오선, 글자의 연한 가장자리 제외)
            if (Math.abs(data[i] - paper[0]) > PAPER_TOL || Math.abs(data[i + 1] - paper[1]) > PAPER_TOL ||
                Math.abs(data[i + 2] - paper[2]) > PAPER_TOL) continue;
            rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
          }
        };
        collect(Math.max(0, a - n), a);
        collect(b + 1, Math.min(w, b + 1 + n));
        const c = rs.length ? [median(rs), median(gs), median(bs)] : paper;
        for (let xx = a; xx <= b; xx++) {
          const i = (row + xx) * 4;
          data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
        }
      }
    }
  }

  // 종이색을 측정해 순백(255)으로 맞춤: 채널별로 종이색 * whiteLevel 이상이면 255가 되도록 배율을 곱함
  function whitenData(data, w, h, s) {
    const pr = []; const pg = []; const pb = [];
    for (let p = 0; p < w * h; p += 5) {
      const i = p * 4;
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
      const mx = Math.max(r, g, b);
      if (0.299 * r + 0.587 * g + 0.114 * b >= s.paperLuma && mx - Math.min(r, g, b) <= s.paperSat * mx) {
        pr.push(r); pg.push(g); pb.push(b);
      }
    }
    if (pr.length < 50) return null;
    const paper = [median(pr), median(pg), median(pb)];
    const gain = paper.map((c) => 255 / Math.max(1, c * s.whiteLevel));
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.min(255, data[i] * gain[0]);
      data[i + 1] = Math.min(255, data[i + 1] * gain[1]);
      data[i + 2] = Math.min(255, data[i + 2] * gain[2]);
    }
    return paper;
  }

  // 밝은 종이 픽셀만 더 밝게 (어두운 악보 기호·색 음표머리는 유지)
  function brightenData(data, start) {
    const range = Math.max(1, 255 - start);
    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma > start) {
        const st = Math.min(1, (luma - start) / range);
        data[i] += (255 - data[i]) * st;
        data[i + 1] += (255 - data[i + 1]) * st;
        data[i + 2] += (255 - data[i + 2]) * st;
      }
    }
  }

  async function maskToBlob(mask, w, h) {
    const img = new ImageData(w, h);
    for (let p = 0; p < w * h; p++) {
      const v = mask[p] ? 255 : 0;
      img.data[p * 4] = v; img.data[p * 4 + 1] = v; img.data[p * 4 + 2] = v; img.data[p * 4 + 3] = 255;
    }
    const c = makeCanvas(w, h);
    c.getContext('2d').putImageData(img, 0, 0);
    return canvasToBlob(c, 'image/png');
  }

  // 이미지 1장 처리. 성공: {blob,width,height,top,bottom,removed,scale,debugMask}, 실패: null
  async function cropImage(file, opts) {
    const s = Object.assign({}, DEFAULT_CROP, opts);
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); // 폰 사진 회전 반영
    } catch (e) {
      bmp = await createImageBitmap(file);
    }
    const sc = Math.min(1, s.maxWidth / bmp.width);
    const W = Math.max(1, Math.round(bmp.width * sc));
    const H = Math.max(1, Math.round(bmp.height * sc));
    const cv = makeCanvas(W, H);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';            // 투명 PNG는 흰 배경 위에 올림
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, W, H);
    if (bmp.close) bmp.close();

    const e = scaleSettings(s, sc);
    const full = ctx.getImageData(0, 0, W, H);
    const rows = findScoreRows(paperFractionOf(full.data, W, H, e), e);
    if (!rows) return null;
    const top = rows[0];
    const bottom = rows[1];
    const ch = bottom - top;
    const part = new ImageData(full.data.slice(top * W * 4, bottom * W * 4), W, ch);

    let removed = 0;
    let debugMask = null;
    if (e.removeBand) {
      const band = detectBand(part.data, W, ch, e);
      const mask = band.keep;
      for (let i = 0; i < mask.length; i++) removed += mask[i];
      const fillArr = mask.slice();
      restoreUnderBand(part.data, band.core, fillArr, W, ch, e, band.bandColor, band.paperColor);
      fillMask(part.data, fillArr, W, ch, e.samplePx, e.growMinLuma);
      if (e.unblend) unblendBand(part.data, mask, band.footprint, W, ch, e, band.bandColor, band.paperColor);
      if (s.debug) debugMask = await maskToBlob(mask, W, ch);
    }
    if (e.whitenPaper) whitenData(part.data, W, ch, e);
    if (e.brighten) brightenData(part.data, e.lumaStart);

    const out = makeCanvas(W, ch);
    out.getContext('2d').putImageData(part, 0, 0);
    const blob = await canvasToBlob(out, s.outType, s.jpegQuality);
    return { blob, width: W, height: ch, top, bottom, removed, scale: sc, debugMask };
  }

  // ===== 코드2: 악보 조립 =====
  function makeComposeSettings(opts) {
    const c = Object.assign({}, DEFAULT_COMPOSE, opts);
    c.dpi = Math.min(600, Math.max(72, Number(c.dpi) || 150));
    c.pageW = Math.round(210 / 25.4 * c.dpi);   // A4 가로 (300dpi → 2480px)
    c.pageH = Math.round(297 / 25.4 * c.dpi);   // A4 세로 (300dpi → 3508px)
    c.marginX = mmToPx(c.marginXmm, c.dpi);
    c.marginY = mmToPx(c.marginYmm, c.dpi);
    c.minGap = mmToPx(c.minGapMm, c.dpi);
    c.maxGap = Math.max(c.minGap, mmToPx(c.maxGapMm, c.dpi));
    c.contentW = c.pageW - 2 * c.marginX;
    c.usable = c.pageH - 2 * c.marginY;
    c.titlePx = Math.round(c.titleSizePt * c.dpi / 72);
    c.hasTitle = !!(c.title && c.title.trim());
    c.titleBlock = c.hasTitle ? Math.round(c.titlePx * 1.3) + mmToPx(c.titleGapMm, c.dpi) : 0;
    c.usableFirst = c.usable - c.titleBlock;   // 첫 장은 제목만큼 공간이 줄어듦
    return c;
  }

  function fits(heights, usable, minGap) {
    const sum = heights.reduce((a, b) => a + b, 0);
    return sum + minGap * (heights.length - 1) <= usable;
  }

  // 9개가 들어가면 9개, 넘치면 8개씩 묶음. [시작, 끝) 목록 반환
  function splitPages(heights, st) {
    const groups = [];
    let i = 0;
    while (i < heights.length) {
      const usable = groups.length === 0 ? st.usableFirst : st.usable;
      let count = Math.min(st.maxPerPage, heights.length - i);
      while (count > st.minPerPage && !fits(heights.slice(i, i + count), usable, st.minGap)) count--;
      groups.push([i, i + count]);
      i += count;
    }
    return groups;
  }

  async function buildPage(blobs, st, isFirst) {
    const bmps = await Promise.all(blobs.map((b) => createImageBitmap(b)));
    const usable = isFirst ? st.usableFirst : st.usable;
    const n = bmps.length;

    let sizes = bmps.map((b) => ({ w: st.contentW, h: Math.round(b.height * st.contentW / b.width) }));
    const sumH = sizes.reduce((a, s) => a + s.h, 0);
    const room = usable - st.minGap * (n - 1);
    if (sumH > room) {                      // 8개로도 넘치면 전체를 같은 비율로 축소
      const f = Math.max(0.01, room) / sumH;
      sizes = sizes.map((s) => ({ w: Math.max(1, Math.round(s.w * f)), h: Math.max(1, Math.round(s.h * f)) }));
    }
    const totalH = sizes.reduce((a, s) => a + s.h, 0);
    let gap = st.minGap;
    if (n > 1) gap = Math.min(st.maxGap, Math.max(st.minGap, (usable - totalH) / (n - 1)));

    const canvas = makeCanvas(st.pageW, st.pageH);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, st.pageW, st.pageH);
    ctx.imageSmoothingQuality = 'high';

    let y = st.marginY;
    if (isFirst && st.hasTitle) {
      let px = st.titlePx;
      ctx.fillStyle = '#000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${px}px ${st.fontFamily}`;
      while (ctx.measureText(st.title).width > st.contentW && px > 20) {  // 긴 제목은 폭에 맞춰 축소
        px -= 2;
        ctx.font = `bold ${px}px ${st.fontFamily}`;
      }
      ctx.fillText(st.title, st.pageW / 2, y + Math.round(st.titlePx * 1.3) / 2);
      y += st.titleBlock;
    }
    bmps.forEach((b, i) => {
      const x = Math.round((st.pageW - sizes[i].w) / 2);
      ctx.drawImage(b, x, Math.round(y), sizes[i].w, sizes[i].h);
      y += sizes[i].h + gap;
      if (b.close) b.close();
    });
    return canvas;
  }

  // items: [{name, blob, width?, height?}] (순서대로). 반환: [{blob, count, first, last}]
  async function composePages(items, opts, onProgress) {
    const st = makeComposeSettings(opts);
    const dims = [];
    for (const it of items) {
      if (it.width && it.height) { dims.push(it); continue; }
      const b = await createImageBitmap(it.blob);
      dims.push(Object.assign({}, it, { width: b.width, height: b.height }));
      if (b.close) b.close();
    }
    const heights = dims.map((d) => Math.round(d.height * st.contentW / d.width));
    const groups = splitPages(heights, st);
    const pages = [];
    for (let g = 0; g < groups.length; g++) {
      const a = groups[g][0];
      const b = groups[g][1];
      const canvas = await buildPage(dims.slice(a, b).map((d) => d.blob), st, g === 0);
      const blob = await canvasToBlob(canvas, 'image/jpeg', st.pageJpegQuality);
      pages.push({ blob, count: b - a, first: dims[a].name, last: dims[b - 1].name });
      if (onProgress) onProgress(g + 1, groups.length);
      await tick();
    }
    return pages;
  }

  async function buildPdf(pages) {
    const J = global.jspdf && global.jspdf.jsPDF;
    if (!J) throw new Error('jsPDF 라이브러리가 로드되지 않았습니다.');
    const pdf = new J({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    for (let i = 0; i < pages.length; i++) {
      if (i > 0) pdf.addPage();
      const bytes = new Uint8Array(await pages[i].blob.arrayBuffer());
      const fmt = pages[i].blob.type === 'image/png' ? 'PNG' : 'JPEG';
      pdf.addImage(bytes, fmt, 0, 0, 210, 297, undefined, 'FAST');
    }
    return pdf.output('blob');
  }

  // ===== 전체 실행: 크롭 → 조립 → PDF =====
  // callbacks: { onLog(msg), onProgress({stage, done, total}), keepOrder }
  async function processAll(files, cropOpts, composeOpts, callbacks) {
    const cb = callbacks || {};
    const log = cb.onLog || function () {};
    const prog = cb.onProgress || function () {};
    let list = Array.from(files);
    if (!cb.keepOrder) {
      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    }

    const items = [];
    const debug = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      try {
        const r = await cropImage(f, cropOpts);
        if (!r) {
          log(`[건너뜀] ${f.name}: 악보 영역을 찾지 못함`);
        } else {
          items.push({ name: f.name, blob: r.blob, width: r.width, height: r.height });
          if (r.debugMask) debug.push({ name: f.name, blob: r.debugMask });
          log(`[완료] ${f.name} | 악보 y=${r.top}~${r.bottom}px | 띠 ${r.removed}픽셀 제거`);
        }
      } catch (e) {
        log(`[오류] ${f.name}: ${e.message}`);
      }
      prog({ stage: 'crop', done: i + 1, total: list.length });
      await tick();
    }
    if (!items.length) {
      log('조립할 악보 이미지가 없습니다.');
      return { pages: [], pdf: null, debug };
    }

    log('악보 조립 중...');
    const pages = await composePages(items, composeOpts, (d, t) => prog({ stage: 'compose', done: d, total: t }));
    pages.forEach((p, i) => log(`[완료] page_${String(i + 1).padStart(2, '0')} (${p.count}개: ${p.first} ~ ${p.last})`));
    const pdf = await buildPdf(pages);
    return { pages, pdf, debug };
  }

  global.CropMerge = {
    DEFAULT_CROP, DEFAULT_COMPOSE,
    cropImage, composePages, buildPdf, processAll,
    _internal: { findScoreRows, paperFractionOf, lavenderMask, detectBand, whitenData, restoreUnderBand, unblendBand, fillMask, brightenData, rowMeansOf,
                 makeComposeSettings, splitPages, removeSmallBlobs, dilate, scaleSettings },
  };
})(typeof window !== 'undefined' ? window : globalThis);
