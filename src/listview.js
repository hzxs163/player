// 虚拟列表：只画视口内的行。三万多行全塞进 DOM 会让滚动条先卡死，
// 所以外层撑出总高度、内层绝对定位当前窗口那几十行。
export function createStationList({ root, rowHeight = 46, renderRow }) {
  const inner = document.createElement('div');
  inner.className = 'vlist-inner';
  root.appendChild(inner);
  let indices = [];
  let start = 0;
  let end = 0;
  let frame = 0;

  function window() {
    const top = root.scrollTop;
    const h = root.clientHeight || 0;
    const overscan = 6;
    const s = Math.max(0, Math.floor(top / rowHeight) - overscan);
    const e = Math.min(indices.length, Math.ceil((top + h) / rowHeight) + overscan);
    return [s, e];
  }

  function paint() {
    frame = 0;
    const [s, e] = window();
    if (s !== start || e !== end) {
      start = s;
      end = e;
      const box = document.createDocumentFragment();
      for (let k = s; k < e; k++) {
        const node = renderRow(indices[k], k);
        if (node) {
          node.style.transform = `translateY(${k * rowHeight}px)`;
          node.style.height = rowHeight + 'px';
          box.appendChild(node);
        }
      }
      inner.replaceChildren(box);
    }
    inner.style.height = indices.length * rowHeight + 'px';
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(paint);
  }

  root.addEventListener('scroll', schedule, { passive: true });

  return {
    setIndices(next) {
      indices = next;
      start = end = -1; // 强制重画：换了索引数组后窗口下标可能数值相同但内容不同
      paint();
    },
    // 条件变了但行数没变时也要重画（同一行的内容可能已经不同）
    refresh() {
      start = end = -1;
      paint();
    },
    scrollToIndex(k) {
      if (k < 0 || k >= indices.length) return;
      const top = k * rowHeight;
      if (top < root.scrollTop || top + rowHeight > root.scrollTop + root.clientHeight) {
        root.scrollTop = Math.max(0, top - root.clientHeight / 2 + rowHeight / 2);
      }
      schedule();
    },
    indexOf(i) {
      return indices.indexOf(i);
    },
    get length() {
      return indices.length;
    },
    resize() {
      start = end = -1;
      paint();
    },
  };
}
