/* ════════ INNO suite UX layer (2026-09-29) ════════
   6개 INNO 앱이 같은 규칙으로 동작하도록 붙이는 공통 층. 앱 코드는 거의 건드리지 않고,
   DOM 을 지켜보다가(MutationObserver) 필요한 속성·동작을 덧붙인다.
     1) 대화창·서랍: role=dialog, 열면 포커스를 안으로, 닫으면 원래 자리로, Tab 순환,
        Esc 로 닫기, 입력을 고친 채 바깥을 누르면 확인.
     2) 키보드: 클릭으로만 열리던 행·칸·항목에 tabindex·role 부여, Enter/Space 로 실행.
     3) 탭 목록: role=tablist/tab, aria-selected.
     4) 토스트: aria-live 로 화면낭독기에도 전달.
     5) 앱 전환: 상단 크롬에 INNO 앱 목록 버튼.
   설정은 window.INNO_UX = {...} (이 스크립트보다 먼저). */
(function () {
  "use strict";
  const C = window.INNO_UX || {};
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  /* ---------- 1) 대화창 ---------- */
  const stack = [];   // {ov, panel, ret, snap}
  const overlaySel = C.overlay || ".overlay";
  const panelSel = C.panel || ".modal,.drawer";
  const isOpen = ov => ov.isConnected && (C.isOpen ? C.isOpen(ov) : (getComputedStyle(ov).display !== "none" && (!C.openClass || ov.classList.contains(C.openClass))));
  function snapshot(panel) {
    return [...panel.querySelectorAll("input,textarea,select")].map(e => e.type === "checkbox" || e.type === "radio" ? e.checked : e.value).join("\u0001");
  }
  function onOpen(ov) {
    if (stack.some(s => s.ov === ov)) return;
    const panel = ov.matches(panelSel) ? ov : (ov.querySelector(panelSel) || ov);
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    const h = panel.querySelector("h1,h2,h3");
    if (h && !panel.getAttribute("aria-label")) panel.setAttribute("aria-label", h.textContent.trim().slice(0, 80));
    const entry = { ov, panel, ret: document.activeElement, snap: null };
    stack.push(entry);
    /* 앱이 같은 대화창의 내용을 통째로 다시 그리면(저장·발급 뒤 재렌더) 그 시점을 새 기준으로 */
    entry.mo = new MutationObserver(() => requestAnimationFrame(() => { entry.snap = snapshot(panel); }));
    entry.mo.observe(panel, { childList: true });
    requestAnimationFrame(() => {
      entry.snap = snapshot(panel);
      if (panel.contains(document.activeElement)) return;
      const first = [...panel.querySelectorAll(FOCUSABLE)].find(e => visible(e) && !e.classList.contains("closex"));
      if (first && /^(INPUT|TEXTAREA|SELECT)$/.test(first.tagName)) first.focus({ preventScroll: true });
      else { if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1"); panel.focus({ preventScroll: true }); }
    });
  }
  function onClose(entry) {
    const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1);
    if (entry.mo) entry.mo.disconnect();
    if (entry.ret && entry.ret.isConnected && typeof entry.ret.focus === "function") entry.ret.focus({ preventScroll: true });
  }
  function dirty(entry) {
    if (C.noDirty && entry.ov.matches(C.noDirty)) return false;   // 입력이 자동 저장되는 창
    return entry.snap != null && snapshot(entry.panel) !== entry.snap;
  }
  function closeTop() {
    const e = stack[stack.length - 1]; if (!e) return false;
    if (dirty(e) && !confirm("입력한 내용이 저장되지 않았습니다. 닫을까요?")) return true;
    e._confirmed = true;
    const btn = e.panel.querySelector(C.closeBtn || ".closex,[data-close]");
    if (btn && visible(btn)) btn.click();
    else if (C.closeOverlay) C.closeOverlay(e.ov);
    else e.ov.remove();
    return true;
  }
  function scan() {
    document.querySelectorAll(overlaySel).forEach(ov => { if (isOpen(ov)) onOpen(ov); });
    for (const e of stack.slice()) if (!isOpen(e.ov)) onClose(e);
  }
  // 바깥(배경) 클릭 — 입력을 고쳤으면 확인 (캡처 단계에서 앱 핸들러보다 먼저)
  document.addEventListener("click", ev => {
    const e = stack[stack.length - 1]; if (!e || ev.target !== e.ov || e._confirmed) return;
    if (dirty(e) && !confirm("입력한 내용이 저장되지 않았습니다. 닫을까요?")) { ev.stopImmediatePropagation(); ev.preventDefault(); }
  }, true);
  document.addEventListener("keydown", ev => {
    const top = stack[stack.length - 1];
    if (ev.key === "Escape" && top) {
      if (document.querySelector(".inno-apps.open")) return;   // 앱 메뉴가 먼저 (메뉴 쪽 핸들러가 닫는다)
      if (closeTop()) { ev.preventDefault(); ev.stopPropagation(); }
      return;
    }
    if (ev.key === "Tab" && top) {   // 포커스 순환
      const f = [...top.panel.querySelectorAll(FOCUSABLE)].filter(visible);
      if (!f.length) return;
      const a = f[0], z = f[f.length - 1];
      if (!top.panel.contains(document.activeElement)) { ev.preventDefault(); a.focus(); }
      else if (ev.shiftKey && document.activeElement === a) { ev.preventDefault(); z.focus(); }
      else if (!ev.shiftKey && document.activeElement === z) { ev.preventDefault(); a.focus(); }
    }
  }, true);

  /* ---------- 2) 키보드로 여는 행·칸 ---------- */
  const clickSel = (C.clickables || []).join(",");
  function markClickables(root) {
    if (!clickSel) return;
    (root.querySelectorAll ? root : document).querySelectorAll(clickSel).forEach(el => {
      if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
      if (!el.hasAttribute("role")) el.setAttribute("role", "button");
    });
  }
  document.addEventListener("keydown", ev => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const el = ev.target;
    if (!clickSel || !el.matches || !el.matches(clickSel) || /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
    ev.preventDefault(); el.click();
  });

  /* ---------- 3) 탭 목록 ---------- */
  function markTabs() {
    (C.tablists || []).forEach(t => {
      document.querySelectorAll(t.list).forEach(list => {
        list.setAttribute("role", "tablist");
        list.querySelectorAll(t.tab).forEach(b => {
          b.setAttribute("role", "tab");
          b.setAttribute("aria-selected", b.classList.contains(t.active) ? "true" : "false");
          if (b.tagName !== "BUTTON" && !b.hasAttribute("tabindex")) b.setAttribute("tabindex", "0");
        });
      });
    });
  }

  /* ---------- 4) 토스트 ---------- */
  function markLive() { (C.live || []).forEach(s => document.querySelectorAll(s).forEach(el => { el.setAttribute("aria-live", "polite"); el.setAttribute("role", "status"); })); }

  /* ---------- 5) 앱 전환 ---------- */
  function buildSwitcher() {
    if (!C.apps || !C.switcherHost) return;
    const host = document.querySelector(C.switcherHost);
    if (!host || host.querySelector(".inno-apps")) return;
    const wrap = document.createElement("div");
    wrap.className = "inno-apps";
    wrap.innerHTML = `<button type="button" class="inno-apps-btn" aria-haspopup="true" aria-expanded="false" title="INNO 앱" aria-label="INNO 앱 전환">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g fill="currentColor"><circle cx="5" cy="5" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/></g></svg></button>
      <div class="inno-apps-menu" role="menu">
        ${C.apps.map(a => `<a role="menuitem" href="${a.url}" ${a.current ? 'aria-current="page"' : 'target="_blank" rel="noopener"'} class="${a.current ? "cur" : ""}">
          <img src="${a.icon}" width="36" height="36" alt=""><span><b>${a.name}</b><small>${a.desc}</small></span></a>`).join("")}
      </div>`;
    const place = C.switcherBefore ? host.querySelector(C.switcherBefore) : null;
    host.insertBefore(wrap, place || null);
    const btn = wrap.querySelector(".inno-apps-btn");
    /* 메뉴는 body 에 붙인다 — 상단 크롬이 clip-path(전체 폭 띠)라 그 안에 두면 잘린다 */
    const menu = wrap.querySelector(".inno-apps-menu");
    menu.classList.add("inno-apps-pop"); document.body.appendChild(menu);
    const set = open => {
      wrap.classList.toggle("open", open); menu.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        const r = btn.getBoundingClientRect();
        menu.style.top = Math.round(r.bottom + 8) + "px";
        menu.style.right = Math.max(12, Math.round(window.innerWidth - r.right)) + "px";
        const c = menu.querySelector("a.cur") || menu.querySelector("a"); c && c.focus();
      }
    };
    btn.addEventListener("click", e => { e.stopPropagation(); set(!wrap.classList.contains("open")); });
    document.addEventListener("click", e => { if (!wrap.contains(e.target) && !menu.contains(e.target)) set(false); });
    window.addEventListener("resize", () => set(false));
    const onKey = e => {
      if (e.key === "Escape") { set(false); btn.focus(); e.stopPropagation(); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const it = [...menu.querySelectorAll("a")], i = it.indexOf(document.activeElement);
        it[(i + (e.key === "ArrowDown" ? 1 : -1) + it.length) % it.length].focus(); e.preventDefault();
      }
    };
    menu.addEventListener("keydown", onKey);
    wrap.addEventListener("keydown", e => { if (e.key === "Escape") { set(false); e.stopPropagation(); } if (e.key === "ArrowDown" && !wrap.classList.contains("open")) { set(true); e.preventDefault(); } });
  }

  function all() { scan(); markClickables(document); markTabs(); markLive(); buildSwitcher(); if (C.after) C.after(); }
  let pending = false;
  const mo = new MutationObserver(() => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; all(); }); });
  function start() { all(); mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  window.INNO_UX_API = { closeTop };
})();
