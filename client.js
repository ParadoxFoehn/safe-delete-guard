/**
 * safe-delete-guard — Client half.
 *
 * 右上角悬浮球（可拖动）：悬停摘要，点击在屏幕中间开窗。
 * 窗口：标题行（回收站 · 刷新 · 总量 · ×）；左宽右窄两栏（一级/二级目录）；
 * 每行末端「删除」并标红「预计 X 日后自动删除」；左下角小方块进设置。
 */
window.__ModuleLoader__.load({
  id: '@local/safe-delete-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/safe-delete/api'
    const ID = '@local/safe-delete-guard'
    const WIN_W = 660
    const WIN_H = 540

    const CSS = [
      '.sdg-fab:hover{filter:brightness(1.06)}',
      '.sdg-scroll{scrollbar-width:thin}',
      '.sdg-btn:hover{filter:brightness(1.05)}',
      '.sdg-row:hover{filter:brightness(1.03)}',
      '.sdg-del:hover{filter:brightness(1.15)}',
    ]

    function fmtSize(n) {
      const MB = 1024 * 1024
      if (n > 100 * MB) return '>99MB'
      if (!n) return '0 B'
      if (n >= MB) return (n / MB).toFixed(1) + 'MB'
      if (n >= 1024) return (n / 1024).toFixed(1) + 'KB'
      return n + 'B'
    }

    function fmtTime(s) {
      if (!s) return ''
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s))
      return m ? (m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5]) : ''
    }

    function toMs(v) {
      if (v == null || v === '') return 0
      if (typeof v === 'number') return v
      const n = Date.parse(String(v))
      return Number.isFinite(n) ? n : 0
    }

    function daysLeft(at, retention) {
      const base = toMs(at)
      if (!base) return ''
      const passed = (Date.now() - base) / 86400000
      const left = Math.max(0, Math.ceil((retention || 0) - passed))
      return left <= 0 ? '预计今天自动删除' : ('预计 ' + left + ' 日后自动删除')
    }

    function resolvePalette(el) {
      let cs = null
      try { cs = el ? getComputedStyle(el) : null } catch { cs = null }
      const pick = (name) => {
        try { return (cs && cs.getPropertyValue(name) || '').trim() } catch { return '' }
      }
      let dark = false
      try {
        const bg = getComputedStyle(document.body).backgroundColor || ''
        const m = /rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(bg)
        if (m) dark = (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 < 120
      } catch { /* ignore */ }
      const bgSolid = pick('--dsw-alias-bg-layer-1') || (dark ? '#1e2025' : '#ffffff')
      const toRgba = (c, a) => {
        let r = 255, g = 255, b = 255
        const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?/.exec(c)
        if (m) { r = Number(m[1]); g = Number(m[2]); b = Number(m[3]) }
        else {
          const hx = /^#([0-9a-f]{6})$/i.exec(String(c).trim())
          if (hx) {
            r = parseInt(hx[1].slice(0, 2), 16)
            g = parseInt(hx[1].slice(2, 4), 16)
            b = parseInt(hx[1].slice(4, 6), 16)
          }
        }
        return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'
      }
      return {
        bg: bgSolid,
        glass: toRgba(bgSolid, 0.92),
        soft: pick('--dsw-alias-bg-layer-2') || (dark ? '#2a2d34' : '#f3f4f7'),
        line: pick('--dsw-alias-border-l1') || (dark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.12)'),
        text: pick('--dsw-alias-label-primary') || (dark ? '#e9ebee' : '#15181d'),
        sub: pick('--dsw-alias-label-tertiary') || (dark ? 'rgba(233,235,238,.62)' : 'rgba(21,24,29,.55)'),
        brand: pick('--dsw-alias-brand-primary') || (dark ? '#79a2f5' : '#2f6fed'),
        danger: '#c0392b',
      }
    }

    function TrashWindow(props) {
      const { onClose, pal } = props
      const [data, setData] = React.useState(null)
      const [sel, setSel] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [confirmEmpty, setConfirmEmpty] = React.useState(false)
      const [err, setErr] = React.useState('')
      const [toast, setToast] = React.useState('')
      const [pending, setPending] = React.useState(null)
      const [view, setView] = React.useState('list')
      const [cfg, setCfg] = React.useState(null)
      const [cfgDraft, setCfgDraft] = React.useState(null)
      const [pendingMigrate, setPendingMigrate] = React.useState(null)
      const [migrate, setMigrate] = React.useState(null)
      const [pos, setPos] = React.useState(() => ({
        x: Math.max(0, Math.round((window.innerWidth - WIN_W) / 2)),
        y: Math.max(0, Math.round((window.innerHeight - WIN_H) / 2)),
      }))
      const timer = React.useRef(null)
      const toastTimer = React.useRef(null)
      const drag = React.useRef(null)
      const winRef = React.useRef(null)

      const flash = (msg) => {
        setToast(msg)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(''), 2200)
      }

      const load = React.useCallback(() => {
        fetch(API + '/trash').then((r) => r.text()).then((txt) => {
          if (!txt) { setErr('接口没有返回内容'); return }
          try {
            const j = JSON.parse(txt)
            if (j && j.ok) { setData(j); setErr('') } else setErr((j && j.error) || '读取失败')
          } catch { setErr('返回的不是 JSON') }
        }).catch((e) => setErr(String(e && e.message ? e.message : e)))
      }, [])

      const loadCfg = React.useCallback(() => {
        fetch(API + '/config').then((r) => r.text()).then((txt) => {
          const j = JSON.parse(txt || '{}')
          if (j && j.ok) { setCfg(j); setCfgDraft({ trash: j.trashDir || '', days: String(j.retentionDays) }) }
        }).catch(() => {})
      }, [])

      React.useEffect(() => {
        load()
        const t = setInterval(load, 5000)
        return () => clearInterval(t)
      }, [load])

      React.useEffect(() => {
        const list = (data && data.sessions) || []
        if (!list.length) { if (sel) setSel(''); return }
        if (!list.some((s) => s.name === sel)) setSel(list[0].name)
      }, [data, sel])

      // 窗口拖动：文档级捕获阶段，避开宿主上游 stopPropagation
      React.useEffect(() => {
        const isHead = (el) => !!(el && el.closest && el.closest('[data-sdg-head]'))
        const isNoDrag = (el) => !!(el && el.closest && el.closest('[data-sdg-nodrag]'))

        const onDown = (e) => {
          if (e.button !== 0 || !isHead(e.target) || isNoDrag(e.target)) return
          const r = winRef.current ? winRef.current.getBoundingClientRect() : { left: pos.x, top: pos.y }
          drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
          e.preventDefault()
          e.stopPropagation()
        }
        const onMove = (e) => {
          const d = drag.current
          if (!d) return
          const maxX = Math.max(0, window.innerWidth - WIN_W)
          const maxY = Math.max(0, window.innerHeight - 120)
          setPos({
            x: Math.min(maxX, Math.max(0, e.clientX - d.dx)),
            y: Math.min(maxY, Math.max(0, e.clientY - d.dy)),
          })
          e.preventDefault()
        }
        const onUp = () => { drag.current = null }

        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('pointermove', onMove, true)
        document.addEventListener('pointerup', onUp, true)
        document.addEventListener('pointercancel', onUp, true)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('pointermove', onMove, true)
          document.removeEventListener('pointerup', onUp, true)
          document.removeEventListener('pointercancel', onUp, true)
        }
      }, [pos.x, pos.y])

      React.useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current)
        if (toastTimer.current) clearTimeout(toastTimer.current)
      }, [])

      function armEmpty() {
        setConfirmEmpty(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setConfirmEmpty(false), 4000)
      }

      function emptyAll() {
        if (!confirmEmpty) { armEmpty(); return }
        setBusy(true)
        fetch(API + '/empty', { method: 'POST' })
          .then((r) => r.text())
          .then(() => { setConfirmEmpty(false); flash('已清空'); load() })
          .catch((e) => setErr(String(e && e.message ? e.message : e)))
          .finally(() => setBusy(false))
      }

      function openDir() {
        fetch(API + '/open', { method: 'POST' })
          .catch((e) => setErr(String(e && e.message ? e.message : e)))
      }

      function doDelete(session, turn) {
        setPending(null)
        fetch(API + '/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session, turn: turn || '' }),
        })
          .then((r) => r.text())
          .then((txt) => {
            let j = {}
            try { j = JSON.parse(txt || '{}') } catch { j = {} }
            const failed = Array.isArray(j.failed) ? j.failed : []
            if (j.ok) {
              flash('已删除')
            } else if (failed.length) {
              // 部分删不掉：文件被占用/权限不足时目录会留在磁盘上，清单里还会出现。
              flash('已删除 ' + (j.removed || 0) + ' 条，' + failed.length + ' 条没删掉（文件可能正被占用）')
            } else {
              flash('删除失败：' + (j.error || '未知错误'))
            }
          })
          .catch((e) => flash('删除失败：' + (e && e.message ? e.message : e)))
          .finally(() => load())
      }

      function persistCfg(target, migrate) {
        setBusy(true)
        fetch(API + '/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ trash: target, retentionDays: Number(cfgDraft.days) }),
        })
          .then((r) => r.text())
          .then((txt) => {
            const j = JSON.parse(txt || '{}')
            if (!j || !j.ok) throw new Error((j && j.error) || '未知错误')
            if (!migrate) return null
            const total = (data && data.count) || 0
            setMigrate({ done: 0, total, failed: 0 })
            const step = () => fetch(API + '/migrate', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ limit: 2 }),
            }).then((r) => r.text()).then((x) => {
              const m = JSON.parse(x || '{}')
              if (!m || !m.ok) throw new Error((m && m.error) || '迁移失败')
              setMigrate((prev) => {
                const done = (prev ? prev.done : 0) + (m.moved || 0)
                return { done, total: done + (m.remaining || 0), failed: (prev ? prev.failed : 0) + (m.failed || 0) }
              })
              if ((m.remaining || 0) > 0) return step()
              return m
            })
            return step()
          })
          .then((m) => {
            setMigrate(null)
            if (m) flash('迁移完成' + (m.failed ? ('，失败 ' + m.failed) : ''))
            else flash('设置已保存')
            setView('list')
            load()
            loadCfg()
          })
          .catch((e) => { setMigrate(null); flash('保存失败：' + (e && e.message ? e.message : e)) })
          .finally(() => setBusy(false))
      }

      function saveCfg() {
        if (!cfgDraft) return
        const next = String(cfgDraft.trash || '').trim()
        const cur = String((cfg && cfg.trashDir) || '').trim()
        if (next !== cur) { setPendingMigrate({ target: next }); return }
        persistCfg(next, false)
      }

      const sessions = (data && data.sessions) || []
      const current = sessions.find((s) => s.name === sel) || null
      const total = data && data.total
      const retention = (data && data.retentionDays) || 7

      const capStyle = { fontSize: 11, color: pal.sub, padding: '2px 8px 8px', letterSpacing: '.04em' }
      const nameStyle = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: pal.text }
      const metaStyle = { fontSize: 11, color: pal.sub, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
      const keepStyle = { fontSize: 10.5, color: pal.danger, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
      const sizeStyle = { flex: 'none', width: 70, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 12.5, color: pal.text }
      const rowBase = { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 8, userSelect: 'none' }
      const delStyle = {
        flex: 'none', border: '1px solid rgba(192,57,43,.45)', background: 'transparent',
        cursor: 'pointer', font: 'inherit', fontSize: 11, color: pal.danger,
        padding: '2px 9px', borderRadius: 999, lineHeight: '16px',
      }
      const btnStyle = {
        flex: 1, font: 'inherit', fontSize: 12.5, padding: '8px 10px', borderRadius: 8,
        cursor: 'pointer', whiteSpace: 'nowrap', border: '1px solid ' + pal.line,
        background: 'transparent', color: pal.text,
      }
      const fieldStyle = {
        width: '100%', boxSizing: 'border-box', fontSize: 12.5, padding: '7px 9px',
        borderRadius: 8, border: '1px solid ' + pal.line, background: 'transparent', color: pal.text,
      }

      const leftRows = sessions.length === 0
        ? h('div', { style: { ...capStyle, textAlign: 'center', padding: '24px 8px' } }, '隔离区是空的')
        : sessions.map((s) => h('div', {
            key: 's:' + s.name,
            className: 'sdg-row',
            style: { ...rowBase, cursor: 'pointer', background: s.name === sel ? pal.soft : 'transparent' },
            title: s.name,
            onClick: () => setSel(s.name),
          },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: nameStyle }, s.name),
              h('div', { style: metaStyle }, s.files + ' 个文件 · ' + s.turns.length + ' 轮' + (s.lastAt ? ' · ' + fmtTime(s.lastAt) : '')),
              h('div', { style: keepStyle }, daysLeft(s.createdAt, retention))),
            h('div', { style: sizeStyle }, fmtSize(s.bytes)),
            h('button', {
              className: 'sdg-del', style: delStyle, title: '删除这个会话的全部回收文件',
              onClick: (e) => {
                e.stopPropagation()
                setPending({ session: s.name, turn: '', files: s.files, bytes: s.bytes, label: s.name })
              },
            }, '删除')))

      const rightRows = !current || current.turns.length === 0
        ? h('div', { style: { ...capStyle, textAlign: 'center', padding: '24px 8px' } },
            current ? '该会话还没有轮次记录' : '先选左边的一级目录')
        : current.turns.map((t) => h('div', {
            key: 't:' + t.label,
            className: 'sdg-row',
            style: rowBase,
          },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: nameStyle }, t.label),
              h('div', { style: metaStyle }, t.files + ' 个文件' + (t.lastAt ? ' · ' + fmtTime(t.lastAt) : '')),
              h('div', { style: keepStyle }, daysLeft(t.createdAt, retention))),
            h('div', { style: sizeStyle }, fmtSize(t.bytes)),
            h('button', {
              className: 'sdg-del', style: delStyle, title: '删除这一轮的回收文件',
              onClick: () => setPending({ session: current.name, turn: t.label, files: t.files, bytes: t.bytes, label: t.label }),
            }, '删除')))

      const settingsBody = h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 16px' }, className: 'sdg-scroll' },
        h('div', { style: { fontSize: 12.5, color: pal.text, marginBottom: 6, fontWeight: 700 } }, '回收站位置'),
        h('select', {
          style: { ...fieldStyle, cursor: 'pointer' },
          value: (cfgDraft && cfgDraft.trash) || '',
          onChange: (e) => setCfgDraft({ ...cfgDraft, trash: e.target.value }),
        }, ((cfg && cfg.options) || [{ value: '', label: '默认：每个盘根下的 .dsh-trash' }]).map((o) => h('option', { key: o.value, value: o.value }, o.label))),
        h('div', { style: { fontSize: 10.5, color: pal.sub, margin: '6px 0 14px', lineHeight: 1.7 } },
          '当前生效：' + ((cfg && cfg.effectiveRoots || []).join('、') || '尚未创建（第一次删除时自动建在盘根）'),
          h('br'), '换成自定义位置后，保存时会问你要不要迁移已有文件。'),
        h('div', { style: { fontSize: 12.5, color: pal.text, marginBottom: 6, fontWeight: 700 } }, '自动删除天数'),
        h('input', {
          style: { ...fieldStyle, width: 120 }, type: 'number', min: 0, max: 3650,
          value: (cfgDraft && cfgDraft.days) || '7',
          onChange: (e) => setCfgDraft({ ...cfgDraft, days: e.target.value }),
        }),
        h('div', { style: { fontSize: 11, color: pal.sub, margin: '4px 0 14px' } },
          '0 = 不自动清理。清理在每次回收之前顺手执行，按每条自己的放入时间算。'),
        h('div', { style: { fontSize: 12.5, color: pal.text, marginBottom: 6, fontWeight: 700 } }, '它是什么'),
        h('div', { style: { fontSize: 11.5, color: pal.sub, lineHeight: 1.7 } },
          '删除不再直接抹掉，而是同盘改名进隔离区，随时可还原。',
          h('br'), '左栏是产生过垃圾的会话，右栏是选中会话的各轮次；每条可单独删除。',
          h('br'), '清空回收站是永久删除，会有二次确认。'),
        h('div', { style: { fontSize: 10.5, color: pal.sub, marginTop: 14 } },
          '配置写在 ' + ((cfg && cfg.configPath) || '%LOCALAPPDATA%\\dsh-safe-delete\\config.json')))

      const listBody = h('div', { style: { display: 'flex', flex: 1, minHeight: 0 } },
        h('div', { style: { flex: '0 0 56%', minWidth: 0, overflowY: 'auto', padding: '8px 6px' }, className: 'sdg-scroll' },
          h('div', { style: capStyle }, '一级目录 · 会话'),
          leftRows),
        h('div', {
          style: { flex: 1, minWidth: 0, overflowY: 'auto', padding: '8px 6px', borderLeft: '1px solid ' + pal.line },
          className: 'sdg-scroll',
        },
          h('div', { style: capStyle }, current ? ('二级目录 · ' + current.name) : '二级目录'),
          rightRows))

      const winStyle = {
        position: 'fixed', zIndex: 2147482000, left: pos.x, top: pos.y,
        width: WIN_W, height: WIN_H, display: 'flex', flexDirection: 'column',
        background: pal.glass, color: pal.text,
        backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
        border: '1px solid ' + pal.line, borderRadius: 12,
        boxShadow: '0 18px 48px rgba(0,0,0,.28)', overflow: 'hidden', fontSize: 12.5,
      }

      const modal = pending
        ? h('div', {
            'data-sdg-nodrag': '1',
            style: {
              position: 'absolute', inset: 0, zIndex: 96, display: 'flex',
              alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.28)',
            },
          },
            h('div', {
              style: {
                width: 330, background: pal.bg, color: pal.text, borderRadius: 10,
                border: '1px solid ' + pal.line, boxShadow: '0 14px 36px rgba(0,0,0,.3)',
                padding: '16px 16px 12px',
              },
            },
              h('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 8 } }, '确认删除？'),
              h('div', { style: { fontSize: 12, color: pal.sub, lineHeight: 1.6 } },
                '将永久删除「' + pending.label + '」下的 ' + pending.files + ' 个文件（' + fmtSize(pending.bytes) + '），不进回收站。'),
              h('div', { style: { display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' } },
                h('button', { style: { ...btnStyle, flex: '0 0 auto', padding: '7px 16px' }, onClick: () => setPending(null) }, '取消'),
                h('button', {
                  style: { ...btnStyle, flex: '0 0 auto', padding: '7px 16px', border: '1px solid ' + pal.danger, background: pal.danger, color: '#fff' },
                  onClick: () => doDelete(pending.session, pending.turn),
                }, '删除'))))
        : null

      return h('div', { ref: winRef, style: winStyle },
        h('div', {
          'data-sdg-head': '1',
          style: {
            display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px',
            borderBottom: '1px solid ' + pal.line, cursor: 'move', userSelect: 'none', touchAction: 'none',
          },
        },
          h('b', { style: { fontSize: 13, color: pal.text } }, view === 'settings' ? '回收站 · 设置' : '回收站'),
          view === 'list'
            ? h('button', {
                'data-sdg-nodrag': '1',
                style: { border: '1px solid ' + pal.line, background: 'transparent', color: pal.text, cursor: 'pointer', fontSize: 11.5, padding: '3px 9px', borderRadius: 999 },
                onClick: () => { load(); flash('已刷新') },
              }, '刷新')
            : null,
          h('span', {
            style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, color: pal.sub, textAlign: 'right', paddingRight: 4 },
          }, total ? ('共 ' + total.files + ' 个文件 · ' + fmtSize(total.bytes)) : ''),
          h('button', {
            'data-sdg-nodrag': '1', title: '关闭',
            style: { border: 0, background: 'transparent', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '2px 6px', borderRadius: 6, color: pal.sub },
            onClick: onClose,
          }, '×')),

        view === 'settings' ? settingsBody : listBody,

        h('div', { style: { position: 'relative', padding: '10px 12px 12px', borderTop: '1px solid ' + pal.line } },
          view === 'settings'
            ? h('div', { style: { display: 'flex', gap: 8 } },
                h('button', { className: 'sdg-btn', style: btnStyle, onClick: () => { setView('list'); loadCfg() } }, '取消'),
                h('button', { className: 'sdg-btn', style: { ...btnStyle, border: '1px solid ' + pal.brand, color: pal.brand }, onClick: saveCfg, disabled: busy }, '保存'))
            : h('div', { style: { display: 'flex', gap: 8, alignItems: 'stretch' } },
                h('button', {
                  'data-sdg-nodrag': '1', title: '设置',
                  style: {
                    flex: 'none', width: 34, border: '1px solid ' + pal.line, borderRadius: 8,
                    background: 'transparent', color: pal.sub, cursor: 'pointer', fontSize: 14,
                  },
                  onClick: () => { setView('settings'); loadCfg() },
                }, '⚙'),
                h('button', { className: 'sdg-btn', style: btnStyle, onClick: openDir }, '前往回收站'),
                h('button', {
                  className: 'sdg-btn',
                  style: {
                    ...btnStyle,
                    border: '1px solid ' + (confirmEmpty ? pal.danger : 'rgba(192,57,43,.55)'),
                    background: confirmEmpty ? pal.danger : 'transparent',
                    color: confirmEmpty ? '#fff' : pal.danger,
                  },
                  onClick: emptyAll, disabled: busy,
                }, busy ? '清理中…' : (confirmEmpty ? '再点一次确认' : '清空回收站'))),
          toast
            ? h('div', {
                style: {
                  position: 'absolute', left: 0, right: 0, bottom: 54, width: 'fit-content', margin: '0 auto',
                  fontSize: 11.5, color: pal.sub, pointerEvents: 'none',
                  background: pal.soft, border: '1px solid ' + pal.line,
                  borderRadius: 999, padding: '3px 10px',
                },
              }, toast)
            : null,
          err ? h('div', { style: { marginTop: 6, fontSize: 11, color: pal.danger, wordBreak: 'break-all' } }, err) : null),

        modal,

        migrate
          ? h('div', {
              'data-sdg-nodrag': '1',
              style: {
                position: 'absolute', inset: 0, zIndex: 98, display: 'flex',
                alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.3)',
              },
            },
              h('div', {
                style: {
                  width: 330, background: pal.bg, color: pal.text, borderRadius: 10,
                  border: '1px solid ' + pal.line, boxShadow: '0 14px 36px rgba(0,0,0,.3)',
                  padding: '16px 16px 14px',
                },
              },
                h('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 8 } }, '正在迁移回收站'),
                h('div', { style: { fontSize: 12, color: pal.sub, marginBottom: 10 } },
                  '已迁移 ' + migrate.done + ' / ' + (migrate.done + Math.max(0, migrate.total - migrate.done)) + ' 项'
                  + (migrate.failed ? ('（失败 ' + migrate.failed + '）') : '')),
                h('div', { style: { height: 6, borderRadius: 3, background: pal.soft, overflow: 'hidden' } },
                  h('div', {
                    style: {
                      height: '100%', width: (migrate.total ? Math.min(100, Math.round(migrate.done / migrate.total * 100)) : 0) + '%',
                      background: pal.brand, transition: 'width .2s ease',
                    },
                  })),
                h('div', { style: { fontSize: 10.5, color: pal.sub, marginTop: 10 } }, '迁移期间请不要关闭窗口')))
          : null,

        pendingMigrate
          ? h('div', {
              'data-sdg-nodrag': '1',
              style: {
                position: 'absolute', inset: 0, zIndex: 97, display: 'flex',
                alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.3)',
              },
            },
              h('div', {
                style: {
                  width: 360, background: pal.bg, color: pal.text, borderRadius: 10,
                  border: '1px solid ' + pal.line, boxShadow: '0 14px 36px rgba(0,0,0,.3)',
                  padding: '16px 16px 12px',
                },
              },
                h('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 8 } }, '检测到回收站位置变更'),
                h('div', { style: { fontSize: 12, color: pal.sub, lineHeight: 1.6 } },
                  '将把所有已回收文件迁移到：' + (pendingMigrate.target || '默认位置') + '。',
                  h('br'), '迁移期间请不要关闭窗口。'),
                h('div', { style: { display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' } },
                  h('button', {
                    style: { ...btnStyle, flex: '0 0 auto', padding: '7px 16px' },
                    onClick: () => setPendingMigrate(null),
                  }, '取消'),
                  h('button', {
                    style: { ...btnStyle, flex: '0 0 auto', padding: '7px 16px', border: '1px solid ' + pal.brand, background: pal.brand, color: '#fff' },
                    onClick: () => { const tgt = pendingMigrate.target; setPendingMigrate(null); persistCfg(tgt, true) },
                  }, '确定'))))
          : null)
    }

    function Fab() {
      const [open, setOpen] = React.useState(false)
      const [hover, setHover] = React.useState(false)
      const [summary, setSummary] = React.useState(null)
      const [disk, setDisk] = React.useState(null)
      const [warn, setWarn] = React.useState(false)
      const [pal, setPal] = React.useState(() => resolvePalette(null))
      const [pos, setPos] = React.useState(() => {
        try {
          const raw = localStorage.getItem('sdg-fab-pos')
          const p = raw ? JSON.parse(raw) : null
          if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p
        } catch { /* ignore */ }
        return { x: Math.max(8, window.innerWidth - 178), y: 8 }
      })
      const wrapRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const closeTimer = React.useRef(null)

      React.useEffect(() => {
        try { setPal(resolvePalette(wrapRef.current)) } catch { /* keep fallback */ }
      }, [])

      React.useEffect(() => {
        let stop = false
        const tick = () => fetch(API + '/trash').then((r) => r.text()).then((t) => {
          if (stop || !t) return
          try {
            const j = JSON.parse(t)
            if (j && j.ok) { setSummary(j.total || { files: 0, bytes: 0 }); setDisk(j.disk || null) }
          } catch { /* ignore */ }
        }).catch(() => {})
        tick()
        const t = setInterval(tick, 20000)
        return () => { stop = true; clearInterval(t) }
      }, [])

      React.useEffect(() => {
        const isFab = (el) => !!(el && el.closest && el.closest('[data-sdg-fab]'))
        const onDown = (e) => {
          if (e.button !== 0 || !isFab(e.target)) return
          dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false }
          e.preventDefault()
          e.stopPropagation()
        }
        const onMove = (e) => {
          const d = dragRef.current
          if (!d) return
          const dx = e.clientX - d.sx
          const dy = e.clientY - d.sy
          if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
          if (d.moved) {
            setPos({
              x: Math.min(window.innerWidth - 52, Math.max(0, d.ox + dx)),
              y: Math.min(window.innerHeight - 52, Math.max(0, d.oy + dy)),
            })
          }
          e.preventDefault()
        }
        const onUp = () => {
          const d = dragRef.current
          dragRef.current = null
          if (!d) return
          if (d.moved) {
            try { setPos((p) => { localStorage.setItem('sdg-fab-pos', JSON.stringify(p)); return p }) } catch { /* ignore */ }
          } else {
            setOpen((v) => !v)
          }
        }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('pointermove', onMove, true)
        document.addEventListener('pointerup', onUp, true)
        document.addEventListener('pointercancel', onUp, true)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('pointermove', onMove, true)
          document.removeEventListener('pointerup', onUp, true)
          document.removeEventListener('pointercancel', onUp, true)
        }
      }, [pos.x, pos.y])

      React.useEffect(() => {
        const low = !!(disk && disk.low)
        if (!low) { setWarn(false); return }
        setWarn(true)
        const hide = setTimeout(() => setWarn(false), 6000)
        const tick = setInterval(() => {
          setWarn(true)
          setTimeout(() => setWarn(false), 6000)
        }, 60000)
        return () => { clearTimeout(hide); clearInterval(tick) }
      }, [disk && disk.low])

      const enter = () => {
        if (closeTimer.current) clearTimeout(closeTimer.current)
        setHover(true)
      }
      const leave = () => {
        if (closeTimer.current) clearTimeout(closeTimer.current)
        closeTimer.current = setTimeout(() => setHover(false), 180)
      }

      const fabStyle = {
        position: 'fixed', left: pos.x, top: pos.y, zIndex: 2147483000,
        width: 46, height: 46, borderRadius: '50%', display: 'flex', alignItems: 'center',
        justifyContent: 'center', cursor: 'grab',
        background: (disk && disk.low) ? '#c0392b' : pal.soft,
        color: (disk && disk.low) ? '#fff' : pal.text,
        border: '1px solid ' + pal.line, boxShadow: '0 2px 10px rgba(0,0,0,.18)',
        opacity: hover || open ? 1 : 0.72, transition: 'opacity .12s ease',
        touchAction: 'none', userSelect: 'none',
      }

      const tipStyle = {
        position: 'fixed', left: pos.x + 56, top: pos.y + 14, zIndex: 2147483001, pointerEvents: 'none',
        background: pal.text, color: pal.bg, fontSize: 11.5,
        padding: '5px 9px', borderRadius: 7, whiteSpace: 'nowrap',
        boxShadow: '0 6px 18px rgba(0,0,0,.25)',
      }

      const lowDisk = !!(disk && disk.low)
      const showWarn = lowDisk && !open && (hover || warn)
      const showTip = hover && !open && summary && !lowDisk

      return h('div', { ref: wrapRef, onMouseEnter: enter, onMouseLeave: leave },
        h('div', { 'data-sdg-fab': '1', className: 'sdg-fab', style: fabStyle, title: '回收站（可拖动）' },
          h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' },
            h('path', { d: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13' }))),
        showWarn
          ? h('div', {
              style: {
                position: 'fixed', left: pos.x + 23, top: pos.y + 56, zIndex: 2147483001,
                transform: 'translateX(-50%)', textAlign: 'center',
                background: '#c0392b', color: '#fff', fontSize: 11.5, padding: '6px 10px',
                borderRadius: 7, whiteSpace: 'nowrap', boxShadow: '0 6px 18px rgba(0,0,0,.3)',
              },
            }, '磁盘空间不足，回收站将清空')
          : null,
        showTip
          ? h('div', { style: tipStyle }, '共 ' + summary.files + ' 个文件 · ' + fmtSize(summary.bytes))
          : null,
        open ? h(TrashWindow, { pal, onClose: () => setOpen(false) }) : null)
    }

    function apply(ctx) {
      const styleEl = document.createElement('style')
      styleEl.setAttribute('data-plugin', ID)
      styleEl.textContent = CSS.join('\n')
      document.head.appendChild(styleEl)
      ctx.effect(() => () => { try { styleEl.remove() } catch { /* gone */ } }, 'safe-delete-guard: styles')

      const slots = ctx.get('slots')
      if (!slots) { console.error('[safe-delete-guard] slots service missing'); return }
      slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: 'safe-delete-guard-fab',
        order: 40,
        label: '回收站',
      }, () => h(Fab)))
    }

    return { inject: ['slots'], apply }
  },
})
