// Gallery of saved lessons: every recording folder (and loose videos) in the
// output folder, with watch / edit / rename / show in folder / delete.

import { icon } from './icons.js';

const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}

function fmtSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1).replace('.', ',')} GB`;
  return `${Math.max(0.1, bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0).replace('.', ',')} MB`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/\./g, '');
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

export function mdeBadge(m) {
  if (!m || !m.phase) return '';
  const pct = (v) => `${Math.round((v || 0) * 100)}%`;
  if (m.phase === 'error' || m.status === 'failed' || m.status === 'superseded') {
    return `<span class="gal-badge mde bad" title="${esc(m.message || m.errorCode || 'Falha no envio')}">MDE · falhou</span>`;
  }
  if (m.status === 'ready') return `<span class="gal-badge mde ok" data-act="mde-open" title="Abrir a aula no painel do MDE">No MDE ✓</span>`;
  if (m.phase === 'uploading') return `<span class="gal-badge mde">MDE · enviando ${pct(m.sentPct)}</span>`;
  if (m.phase === 'processing') return `<span class="gal-badge mde">MDE · processando ${Math.round(m.encodeProgress || 0)}%</span>`;
  return '<span class="gal-badge mde">MDE · preparando</span>';
}

export class Gallery {
  constructor(opts) {
    Object.assign(this, opts); // api, toast, confirm, getDir, onWatch, onEdit, onEmptyAction, getMde, canMde, onMdeSend, onMdeOpen
    this.el = $('#gallery');
    this.grid = $('#gal-grid');
    this.menu = $('#gal-menu');
    this.items = [];
    this.filter = 'all';
    this.query = '';
    this.stale = true;
    this.menuFor = null;
    this.loading = null;
    this.bind();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  show() {
    this.el.hidden = false;
    document.body.classList.add('in-gallery');
    if (this.stale) this.load();
    else this.render();
  }

  hide() {
    this.el.hidden = true;
    document.body.classList.remove('in-gallery');
    this.closeMenu();
  }

  markStale() {
    this.stale = true;
    if (this.isOpen) this.load();
  }

  async load() {
    this.stale = false;
    const first = !this.items.length;
    $('#gal-loading').hidden = !first;
    if (first) this.grid.innerHTML = '';
    $('#gal-empty').hidden = true;
    const run = this.api.gallery.list(this.getDir()).catch((err) => {
      this.toast(`Não foi possível ler a pasta das aulas. ${err.message || ''}`, 'error');
      return [];
    });
    this.loading = run;
    const items = await run;
    if (this.loading !== run) return;
    this.items = items;
    $('#gal-loading').hidden = true;
    this.render();
  }

  visible() {
    const q = this.query.trim().toLowerCase();
    return this.items.filter((it) => (this.filter === 'all' || it.orientation === this.filter)
      && (!q || it.title.toLowerCase().includes(q)));
  }

  render() {
    const list = this.visible();
    const total = this.items.length;
    $('#gal-count').textContent = total ? `${total} ${total === 1 ? 'aula' : 'aulas'}` : '';
    $('#gal-empty').hidden = total > 0;
    if (total && !list.length) {
      this.grid.innerHTML = '<p class="props-empty" style="grid-column:1/-1;text-align:center;padding:40px 0">Nenhuma aula encontrada com esse filtro.</p>';
      return;
    }
    this.grid.innerHTML = list.map((it) => {
      const vertical = it.orientation === 'v';
      const files = it.trackCount ? ` · ${it.trackCount + 1} arquivos` : '';
      const thumb = it.thumb
        ? `<img src="${esc(it.thumb)}" alt="" loading="lazy" />`
        : `<span class="noimg">${icon('film', 26)}</span>`;
      return `
        <article class="gal-card" data-id="${esc(it.id)}">
          <div class="gal-thumb ${vertical ? 'v' : ''}" data-act="watch" ${it.thumb ? `style="--thumb:url('${esc(it.thumb)}')"` : ''}>
            ${thumb}
            <div class="gal-badges">
              ${it.status === 'draft' ? '<span class="gal-badge draft" title="Gravada, mas ainda não exportada">Rascunho</span>' : ''}
              ${vertical ? `<span class="gal-badge orient">${'9:16'}</span>` : ''}
              ${mdeBadge(this.getMde(it))}
            </div>
            <span class="gal-dur">${fmtDur(it.duration)}</span>
            <div class="gal-hover">
              <button data-act="watch">${icon('play', 14)} Assistir</button>
              <button class="alt" data-act="edit">${icon('scissors', 14)} Editar</button>
            </div>
          </div>
          <div class="gal-info">
            <div class="gal-meta">
              <b data-act="rename-inline" title="${esc(it.title)}">${esc(it.title)}</b>
              <small>${fmtDate(it.createdAt)} · ${fmtSize(it.size)}${files}</small>
            </div>
            <button class="gal-more" data-act="menu" title="Mais opções">${icon('more', 16)}</button>
          </div>
        </article>`;
    }).join('');
  }

  itemFrom(el) {
    const card = el.closest('[data-id]');
    return card ? this.items.find((it) => it.id === card.dataset.id) : null;
  }

  bind() {
    $('#gal-search').addEventListener('input', (e) => { this.query = e.target.value; this.render(); });
    $('#gal-filter').addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      this.filter = b.dataset.v;
      [...$('#gal-filter').children].forEach((x) => x.classList.toggle('on', x === b));
      this.render();
    });
    $('#gal-refresh').addEventListener('click', () => this.load());
    $('#gal-folder').addEventListener('click', async () => {
      const res = await this.api.openPath(this.getDir());
      if (res) this.toast('A pasta ainda não existe. Ela será criada na primeira gravação.');
    });
    $('#gal-go-studio').addEventListener('click', () => this.onEmptyAction());

    this.grid.addEventListener('click', (e) => {
      const actEl = e.target.closest('[data-act]');
      if (!actEl) return;
      const it = this.itemFrom(actEl);
      if (!it) return;
      const act = actEl.dataset.act;
      if (act === 'mde-open') { const m = this.getMde(it); if (m && m.adminUrl) this.onMdeOpen(m.adminUrl); return; }
      if (act === 'watch') this.onWatch(it);
      else if (act === 'edit') this.onEdit(it);
      else if (act === 'menu') { e.stopPropagation(); this.openMenu(it, actEl); }
    });
    this.grid.addEventListener('dblclick', (e) => {
      const t = e.target.closest('[data-act="rename-inline"]');
      if (t) this.startRename(this.itemFrom(t));
    });

    this.menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-gal-act]');
      if (!b || !this.menuFor) return;
      const it = this.menuFor;
      this.closeMenu();
      const act = b.dataset.galAct;
      if (act === 'edit') this.onEdit(it);
      else if (act === 'rename') this.startRename(it);
      else if (act === 'folder') this.api.showItem(it.main);
      else if (act === 'mde-send') this.onMdeSend(it);
      else if (act === 'mde-open') { const m = this.getMde(it); if (m && m.adminUrl) this.onMdeOpen(m.adminUrl); }
      else if (act === 'delete') this.remove(it);
    });
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('#gal-menu, [data-act="menu"]')) this.closeMenu();
    });
    $('#gal-scroll').addEventListener('scroll', () => this.closeMenu());
  }

  openMenu(it, anchor) {
    if (this.menuFor === it && !this.menu.hidden) {
      this.closeMenu();
      return;
    }
    this.menuFor = it;
    const m = this.getMde(it);
    const busy = m && ['reserving', 'uploading', 'processing'].includes(m.phase);
    const sendBtn = this.menu.querySelector('[data-gal-act="mde-send"]');
    sendBtn.hidden = it.kind !== 'project' || it.status !== 'ready' || !this.canMde() || busy;
    sendBtn.lastChild.textContent = m && m.status === 'ready' ? ' Enviar de novo ao MDE' : ' Enviar para o MDE';
    this.menu.querySelector('[data-gal-act="mde-open"]').hidden = !(m && m.adminUrl);
    this.menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = this.menu.offsetWidth;
    const h = this.menu.offsetHeight;
    const top = r.bottom + 6 + h > window.innerHeight ? r.top - h - 6 : r.bottom + 6;
    this.menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    this.menu.style.top = `${Math.max(52, top)}px`;
  }

  closeMenu() {
    this.menu.hidden = true;
    this.menuFor = null;
  }

  startRename(it) {
    if (!it) return;
    const card = this.grid.querySelector(`[data-id="${CSS.escape(it.id)}"]`);
    const label = card && card.querySelector('[data-act="rename-inline"]');
    if (!label) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = it.title;
    input.maxLength = 120;
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      if (save && title && title !== it.title) {
        try {
          const updated = await this.api.gallery.rename(it, title);
          const i = this.items.indexOf(it);
          if (i >= 0 && updated) this.items[i] = updated;
        } catch (err) {
          this.toast(`Não foi possível renomear. ${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error');
        }
      }
      this.render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  async remove(it) {
    const ok = await this.confirm({
      title: `Excluir “${it.title}”?`,
      text: it.kind === 'project'
        ? 'A pasta da aula, com todos os arquivos, vai para a Lixeira do Windows.'
        : 'O arquivo vai para a Lixeira do Windows.',
      ok: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.gallery.trash(it);
      this.items = this.items.filter((x) => x !== it);
      this.render();
      this.toast('Aula enviada para a Lixeira.');
    } catch (err) {
      this.toast(`Não foi possível excluir: o arquivo pode estar aberto em outro programa. ${err.message || ''}`, 'error');
    }
  }
}
