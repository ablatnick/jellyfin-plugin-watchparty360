/* Watch Party plugin: watch together in a virtual theater, Xbox 360 style. */
(function () {
    'use strict';
    if (window.__watchPartyPlugin) return;
    window.__watchPartyPlugin = true;

    var VERSION = '__WP_VERSION__';
    var SEATS = 8;
    var REACTIONS = [
        { key: 'laugh', emoji: '😂', label: 'Laugh' },
        { key: 'clap', emoji: '👏', label: 'Clap' },
        { key: 'cheer', emoji: '🎉', label: 'Cheer' },
        { key: 'wow', emoji: '😮', label: 'Wow' },
        { key: 'scared', emoji: '😱', label: 'Scared' },
        { key: 'sad', emoji: '😢', label: 'Sad' },
        { key: 'love', emoji: '❤️', label: 'Love it' },
        { key: 'boo', emoji: '👎', label: 'Boo' },
        { key: 'popcorn', emoji: '🍿', label: 'Popcorn' },
        { key: 'pause', emoji: '✋', label: 'Ask to pause' }
    ];
    var REACTION = {};
    REACTIONS.forEach(function (r) { REACTION[r.key] = r; });

    var S = {
        party: null,
        partyId: null,
        seq: 0,
        primed: false,       // false until the first state of a party arrives, so old reactions don't replay
        clockOffset: 0,
        invites: [],
        dismissed: {},
        panelOpen: false,
        chat: [],
        lastUser: null,
        mode: readPref('wp-mode', 'theater'),
        pointerAt: 0
    };

    // ---------- helpers ----------

    function readPref(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
    function writePref(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

    function client() {
        var a = window.ApiClient;
        if (!a || typeof a.accessToken !== 'function' || !a.accessToken()) return null;
        if (typeof a.getCurrentUserId !== 'function' || !a.getCurrentUserId()) return null;
        return a;
    }

    function call(method, path, body) {
        var a = client();
        if (!a) return Promise.reject(new Error('Not signed in'));
        var opts = {
            method: method,
            headers: { Authorization: 'MediaBrowser Token="' + a.accessToken() + '"' }
        };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        return fetch(a.getUrl('WatchParty/' + path), opts).then(function (res) {
            if (res.status === 400) return res.text().then(function (t) { throw new Error(t.replace(/^"|"$/g, '') || 'That didn’t work'); });
            if (!res.ok) throw new Error('Something went wrong (HTTP ' + res.status + ')');
            return res.status === 204 ? null : res.json();
        });
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function el(html) {
        var t = document.createElement('template');
        t.innerHTML = html.trim();
        return t.content.firstChild;
    }

    function hue(s) {
        var h = 0;
        s = String(s || '');
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
        return h;
    }

    // Avatar parts. The server only accepts these style names, and colors as #rrggbb.
    var LOOK = {
        skins: ['#ffdbc4', '#f1c27d', '#e0ac69', '#c68642', '#a0663a', '#8d5524', '#5c3a21', '#3b2414'],
        hairStyles: [['short', 'Short'], ['long', 'Long'], ['curly', 'Curly'], ['bun', 'Bun'], ['ponytail', 'Ponytail'], ['mohawk', 'Mohawk'], ['spiky', 'Spiky'], ['bald', 'Bald']],
        hairColors: ['#1c1c1c', '#2b1d14', '#4a2f1d', '#6b4423', '#a0703c', '#d8b26a', '#e8d9a8', '#7a2e1d', '#c0392b', '#8f8f8f', '#eeeeee', '#3f51b5', '#e91e8c', '#26a69a'],
        tops: [['tee', 'T-shirt'], ['stripes', 'Stripes'], ['hoodie', 'Hoodie'], ['jersey', 'Jersey'], ['suit', 'Suit']],
        topColors: ['#d32f2f', '#f57c00', '#fbc02d', '#388e3c', '#00897b', '#0288d1', '#3949ab', '#7b1fa2', '#c2185b', '#5d4037', '#455a64', '#212121', '#fafafa', '#9ccc65'],
        accessories: [['none', 'None'], ['glasses', '👓 Glasses'], ['shades', '🕶 Shades'], ['headphones', '🎧 Headphones'], ['cap', '🧢 Cap'], ['beanie', 'Beanie'], ['partyhat', '🥳 Party hat'], ['crown', '👑 Crown'], ['catears', '🐱 Cat ears']]
    };

    // Until someone designs their own, their person is made up from their name.
    function defaultLook(name) {
        var h = hue(name), pick = function (list, salt) { return list[(h * 7 + salt * 13) % list.length]; };
        return {
            Skin: pick(LOOK.skins, 1),
            HairStyle: pick(LOOK.hairStyles.slice(0, 7), 2)[0],
            HairColor: pick(LOOK.hairColors.slice(0, 9), 3),
            Top: pick(LOOK.tops.slice(0, 3), 4)[0],
            TopColor: pick(LOOK.topColors, 5),
            Accessory: 'none',
            UsePhoto: false
        };
    }

    function userImage(id, tag, size) {
        var a = client();
        return tag && a ? a.getUrl('UserImage', { userId: id, tag: tag, maxHeight: size * 2, quality: 90 }) : null;
    }

    function avatar(id, name, tag, size) {
        var initial = esc((name || '?').trim().charAt(0).toUpperCase());
        var style = 'width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.45) + 'px;background:hsl(' + hue(name) + ',45%,38%)';
        var src = userImage(id, tag, size);
        return '<span class="wp-avatar" style="' + style + '" title="' + esc(name) + '">' + initial +
            (src ? '<img src="' + esc(src) + '" alt="" onerror="this.remove()">' : '') + '</span>';
    }

    function itemImage(id, tag, type, h) {
        var a = client();
        return tag && a ? a.getUrl('Items/' + id + '/Images/' + type, { tag: tag, maxHeight: h, quality: 85 }) : null;
    }

    function clock(ticks) {
        var t = Math.max(0, Math.floor((ticks || 0) / 1e7));
        var h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
        return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    // Only touch the DOM when something changed: every write wakes the MutationObserver, which renders again.
    function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
    function setHtml(node, html) { if (node.__html !== html) { node.__html = html; node.innerHTML = html; } }

    function toast(msg) {
        var t = el('<div class="wp-toast" role="status">' + esc(msg) + '</div>');
        document.body.appendChild(t);
        setTimeout(function () { t.classList.add('wp-toast-out'); }, 2600);
        setTimeout(function () { t.remove(); }, 3100);
    }

    function fail(err) { toast(err && err.message ? err.message : 'That didn’t work, try again'); }

    function hashParam(name) {
        var q = location.hash.split('?')[1] || '';
        return new URLSearchParams(q).get(name);
    }

    function member(userId) {
        if (!S.party) return null;
        for (var i = 0; i < S.party.Members.length; i++) {
            if (S.party.Members[i].UserId === userId) return S.party.Members[i];
        }
        return null;
    }

    function isBackKey(e) {
        return e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack' || e.keyCode === 461 || e.keyCode === 10009;
    }

    var ICON = '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" fill="currentColor">' +
        '<path d="M3 4h18a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm1 2v7h16V6H4Z"/>' +
        '<circle cx="6.5" cy="17.6" r="1.7"/><circle cx="12" cy="17.6" r="1.7"/><circle cx="17.5" cy="17.6" r="1.7"/>' +
        '<path d="M3.6 22a2.9 2.9 0 0 1 5.8 0Zm5.5 0a2.9 2.9 0 0 1 5.8 0Zm5.5 0a2.9 2.9 0 0 1 5.8 0Z"/></svg>';

    // ---------- styles ----------

    function addStyles() {
        if (document.getElementById('wp-styles')) return;
        var css = [
            // shared bits
            '.wp-avatar{position:relative;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;overflow:hidden;color:#fff;font-weight:600;flex:0 0 auto;line-height:1}',
            '.wp-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
            '.wp-btn{font:inherit;padding:.55em 1.1em;border-radius:.35em;border:0;cursor:pointer;background:rgba(255,255,255,.1);color:inherit;line-height:1.2}',
            '.wp-btn:hover{background:rgba(255,255,255,.18)}',
            '.wp-btn-primary{background:#00a4dc;color:#fff;font-weight:600}',
            '.wp-btn-primary:hover{background:#14b4ec}',
            '.wp-btn-danger{color:#ff8a80}',
            '.wp-btn:disabled{opacity:.5;cursor:default}',
            '.wp-btn:focus-visible,.wp-icon-btn:focus-visible,.wp-opt input:focus-visible,.wp-panel input:focus-visible{outline:2px solid #fff;outline-offset:2px}',
            '.wp-toast{position:fixed;left:50%;bottom:2em;transform:translateX(-50%);z-index:100003;background:#303030;color:#fff;padding:.7em 1.2em;border-radius:.4em;box-shadow:0 4px 20px rgba(0,0,0,.5);transition:opacity .4s;max-width:calc(100vw - 32px)}',
            '.wp-toast-out{opacity:0}',
            '.btnWatchParty .detailButton-icon svg{width:1em;height:1em;vertical-align:middle}',
            '.btnWatchParty.wp-active .detailButton-icon{color:#00a4dc}',

            // dialogs
            '.wp-backdrop{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px}',
            '.wp-dialog{background:#202020;color:#eee;border-radius:.6em;width:100%;max-width:27em;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.6);font-size:1rem;overflow:hidden}',
            '.wp-dialog h2{margin:0;padding:1em 1.1em .3em;font-size:1.2em;font-weight:600}',
            '.wp-sub{padding:0 1.35em .6em;opacity:.65;font-size:.9em}',
            '.wp-list{overflow-y:auto;padding:0 .7em;min-height:3em}',
            '.wp-opt{display:flex;align-items:center;gap:.7em;padding:.5em .6em;border-radius:.35em;cursor:pointer}',
            '.wp-opt:hover,.wp-opt:focus-within{background:rgba(255,255,255,.08)}',
            '.wp-opt input{width:1.15em;height:1.15em;accent-color:#00a4dc;margin:0}',
            '.wp-opt .wp-meta{margin-left:auto;font-size:.8em;opacity:.6}',
            '.wp-dot{display:inline-block;width:.55em;height:.55em;border-radius:50%;background:#555;margin-right:.35em}',
            '.wp-dot-on{background:#4caf50}',
            '.wp-empty{padding:1em .6em;opacity:.6}',
            '.wp-field{display:flex;flex-direction:column;gap:.35em;padding:.8em 1.35em 0;font-size:.9em}',
            '.wp-field select{font:inherit;padding:.5em;border-radius:.35em;border:1px solid rgba(255,255,255,.15);background:#121212;color:inherit}',
            '.wp-actions{display:flex;justify-content:flex-end;gap:.6em;padding:1em 1.2em;flex-wrap:wrap}',

            // invite card
            '.wp-invites{position:fixed;top:4.5em;right:16px;z-index:100001;display:flex;flex-direction:column;gap:.7em;width:min(24em,calc(100vw - 32px))}',
            '.wp-invite{display:flex;gap:.8em;background:#1d1d1d;color:#eee;border-radius:.6em;padding:.8em;box-shadow:0 8px 30px rgba(0,0,0,.6);border-left:4px solid #00a4dc;animation:wp-slide .35s ease-out}',
            '.wp-invite-poster{flex:0 0 3.6em;aspect-ratio:2/3;border-radius:.3em;background:#333 center/cover}',
            '.wp-invite-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:.35em}',
            '.wp-invite-who{display:flex;align-items:center;gap:.45em;font-size:.88em;opacity:.85}',
            '.wp-invite-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.wp-invite select{font:inherit;font-size:.85em;padding:.3em;border-radius:.3em;background:#121212;color:inherit;border:1px solid rgba(255,255,255,.15);max-width:100%}',
            '.wp-invite .wp-actions{padding:.2em 0 0;justify-content:flex-start}',
            '@keyframes wp-slide{from{transform:translateX(30px);opacity:0}to{transform:none;opacity:1}}',

            // pill + panel
            '.wp-pill{position:fixed;right:16px;bottom:16px;z-index:100000;display:flex;align-items:center;gap:.6em;padding:.45em .9em .45em .45em;border-radius:2em;border:0;background:#1d1d1d;color:#eee;font:inherit;font-size:.95rem;box-shadow:0 6px 24px rgba(0,0,0,.55);cursor:pointer;max-width:calc(100vw - 32px)}',
            '.wp-pill:hover{background:#262626}',
            '.wp-pill-poster{width:2.2em;height:2.2em;border-radius:50%;background:#333 center/cover;flex:0 0 auto}',
            '.wp-pill-text{display:flex;flex-direction:column;align-items:flex-start;min-width:0;line-height:1.2}',
            '.wp-pill-text b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:12em}',
            '.wp-pill-text span{font-size:.8em;opacity:.7}',
            '.wp-live{display:inline-block;width:.5em;height:.5em;border-radius:50%;background:#e53935;margin-right:.35em;animation:wp-blink 1.6s infinite}',
            '@keyframes wp-blink{50%{opacity:.3}}',
            '.wp-pill-pop{position:absolute;right:1em;bottom:100%;font-size:1.6em;pointer-events:none;animation:wp-float 1.8s ease-out forwards}',
            '.wp-panel{position:fixed;right:16px;bottom:16px;z-index:100001;width:min(25em,calc(100vw - 32px));max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:#181818;color:#eee;border-radius:.8em;box-shadow:0 12px 50px rgba(0,0,0,.7);overflow:hidden;font-size:.95rem}',
            '.wp-panel-head{position:relative;padding:.8em 2.8em .6em 1em;background:linear-gradient(180deg,rgba(0,0,0,.2),#181818),#2a1414 center/cover}',
            '.wp-panel-head h3{margin:0;font-size:1.1em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.wp-panel-head .wp-subline{font-size:.85em;opacity:.75;margin-top:.15em}',
            '.wp-close{position:absolute;top:.5em;right:.5em}',
            '.wp-icon-btn{width:2.2em;height:2.2em;border-radius:50%;border:0;background:rgba(0,0,0,.45);color:#fff;font-size:1em;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}',
            '.wp-icon-btn:hover{background:rgba(255,255,255,.2)}',
            '.wp-mini{--s:2.6em;position:relative;margin:.6em .6em 0;border-radius:.5em;overflow:hidden;background:#0b0606;height:calc(var(--s)*2.6)}',
            '.wp-mini .wp-row{position:absolute;left:0;right:0;bottom:0;height:calc(var(--s)*1.25)}',
            '.wp-mini-screen{position:absolute;left:12%;right:12%;top:8%;height:42%;border-radius:2px;background:#222 center/cover;box-shadow:0 0 18px rgba(160,190,255,.25)}',
            '.wp-status{padding:.6em 1em 0;font-size:.9em}',
            '.wp-members{padding:.3em .6em;display:flex;flex-direction:column;gap:.1em;overflow-y:auto;max-height:9em}',
            '.wp-member{display:flex;align-items:center;gap:.6em;padding:.3em .4em;border-radius:.35em}',
            '.wp-member .wp-name-col{flex:1;min-width:0;line-height:1.2}',
            '.wp-member .wp-name-col small{display:block;opacity:.6;font-size:.78em}',
            '.wp-member .wp-btn{font-size:.8em;padding:.35em .7em}',
            '.wp-badge{font-size:.72em;background:#00a4dc;color:#fff;border-radius:.3em;padding:.1em .4em;margin-left:.35em;vertical-align:middle}',
            '.wp-controls{display:flex;flex-wrap:wrap;gap:.5em;padding:.5em 1em}',
            '.wp-reacts{display:flex;flex-wrap:wrap;gap:.25em;padding:.2em .8em}',
            '.wp-react{font-size:1.35em;width:1.9em;height:1.9em;border-radius:50%;border:0;background:transparent;cursor:pointer;line-height:1;padding:0;transition:transform .12s}',
            '.wp-react:hover,.wp-react:focus-visible{background:rgba(255,255,255,.12);transform:scale(1.15);outline:none}',
            '.wp-log{flex:1;min-height:4em;max-height:11em;overflow-y:auto;padding:.4em 1em;font-size:.88em;display:flex;flex-direction:column;gap:.25em;border-top:1px solid rgba(255,255,255,.06)}',
            '.wp-log .wp-sys{opacity:.55;font-style:italic}',
            '.wp-log b{font-weight:600}',
            '.wp-say{display:flex;gap:.4em;padding:.5em .8em .8em}',
            '.wp-say input{flex:1;min-width:0;font:inherit;padding:.5em .7em;border-radius:2em;border:1px solid rgba(255,255,255,.15);background:#0f0f0f;color:inherit}',

            // theater (inside the video player)
            '.wp-scene{position:absolute;inset:0;z-index:0;pointer-events:none;overflow:hidden;display:none;background:radial-gradient(ellipse at 50% 30%,#2a1a1a 0%,#120909 55%,#050303 100%)}',
            '.wp-theater .wp-scene{display:block}',
            '.wp-curtain{position:absolute;top:0;bottom:22%;width:14%;background:repeating-linear-gradient(90deg,#5e0b10 0,#8d1520 3%,#a51c27 4.5%,#7a1019 6.5%,#5e0b10 8%);box-shadow:inset 0 -40px 60px rgba(0,0,0,.6)}',
            '.wp-curtain-l{left:0;border-bottom-right-radius:60% 12%}',
            '.wp-curtain-r{right:0;border-bottom-left-radius:60% 12%}',
            '.wp-valance{position:absolute;top:0;left:0;right:0;height:4%;background:repeating-linear-gradient(90deg,#6a0d14 0,#9b1a25 2%,#6a0d14 4%);box-shadow:0 6px 18px rgba(0,0,0,.6)}',
            '.wp-floor{position:absolute;left:0;right:0;bottom:0;height:34%;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.9))}',
            '.wp-glow{position:absolute;left:13%;right:13%;top:5%;height:62%;box-shadow:0 0 90px 10px rgba(140,170,255,.18);transition:box-shadow .6s}',
            '.wp-theater .wp-scene.wp-lights{background:radial-gradient(ellipse at 50% 30%,#4a3030 0%,#2a1717 55%,#140b0b 100%)}',
            '.wp-theater video{position:absolute!important;left:13%!important;top:5%!important;width:74%!important;height:62%!important;z-index:1;object-fit:contain!important;background:#000}',
            '.wp-theater .videoSubtitles{bottom:35%!important;z-index:3}',
            '.wp-stage-row{position:absolute;left:5%;right:5%;bottom:0;height:31%;z-index:2;pointer-events:none;--s:min(9vw,15vh)}',
            '.wp-stage-row .wp-row{position:absolute;inset:0}',
            '.wp-fullrow{display:none}',

            // seats + avatars
            '.wp-row{display:flex;justify-content:center;align-items:flex-end;gap:calc(var(--s)*.12)}',
            '.wp-seat{position:relative;width:var(--s);height:calc(var(--s)*1.25);flex:0 0 auto}',
            '.wp-chair{position:absolute;left:-2%;right:-2%;bottom:0;height:56%;z-index:2;border-radius:28% 28% 8% 8%/40% 40% 8% 8%;background:linear-gradient(180deg,#9b1c24 0%,#6d1018 55%,#3d070c 100%);box-shadow:inset 0 3px 3px rgba(255,255,255,.12),0 4px 10px rgba(0,0,0,.6)}',
            '.wp-chair::after{content:"";position:absolute;left:12%;right:12%;top:14%;bottom:30%;border-radius:22%/30%;background:rgba(0,0,0,.18)}',
            '.wp-fig{position:absolute;left:0;right:0;bottom:22%;height:100%;z-index:1;transition:transform .35s cubic-bezier(.3,1.6,.5,1)}',
            '.wp-seat.wp-empty-seat .wp-fig{display:none}',
            '.wp-torso{position:absolute;left:14%;right:14%;bottom:0;height:46%;border-radius:45% 45% 12% 12%/55% 55% 12% 12%;background:var(--top);overflow:visible}',
            '.wp-neck{position:absolute;left:40%;right:40%;top:-6%;height:16%;border-radius:0 0 40% 40%;background:var(--skin);filter:brightness(.88)}',
            '.wp-top-stripes .wp-torso{background:repeating-linear-gradient(180deg,var(--top) 0 16%,rgba(255,255,255,.85) 16% 24%)}',
            '.wp-top-hoodie .wp-torso{box-shadow:inset 0 -6px 10px rgba(0,0,0,.25)}',
            '.wp-top-hoodie .wp-torso::before{content:"";position:absolute;left:20%;right:20%;top:-14%;height:40%;border-radius:50%;background:var(--top);filter:brightness(.78)}',
            '.wp-top-jersey .wp-torso{background:linear-gradient(90deg,#fff 0 13%,var(--top) 13% 87%,#fff 87%)}',
            '.wp-top-jersey .wp-torso::after{content:attr(data-num);position:absolute;left:0;right:0;top:22%;text-align:center;font-weight:800;color:#fff;font-size:calc(var(--s)*.2);text-shadow:0 0 2px rgba(0,0,0,.6);font-family:Arial,sans-serif}',
            '.wp-top-suit .wp-torso{background:linear-gradient(90deg,var(--top) 0 38%,#f5f5f5 38% 62%,var(--top) 62%)}',
            '.wp-top-suit .wp-torso::after{content:"";position:absolute;left:46%;right:46%;top:6%;height:48%;background:#b71c1c;clip-path:polygon(20% 0,80% 0,100% 80%,50% 100%,0 80%)}',
            '.wp-top-suit .wp-neck,.wp-top-hoodie .wp-neck{display:none}',
            // hair seen from behind, and the parts that stick out from the head
            '.wp-hairback{position:absolute;display:none;background:var(--hair)}',
            '.wp-hs-long .wp-hairback{display:block;left:20%;right:20%;bottom:20%;height:52%;border-radius:42% 42% 18% 18%}',
            '.wp-hs-curly .wp-hairback{display:block;left:15%;right:15%;bottom:36%;height:52%;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.14) 30%,transparent 32%) 0 0/24% 20%,var(--hair)}',
            '.wp-hs-bun .wp-hairback{display:block;left:37%;right:37%;bottom:77%;height:21%;border-radius:50%}',
            '.wp-hs-ponytail .wp-hairback{display:block;left:41%;right:41%;bottom:22%;height:36%;border-radius:40% 40% 50% 50%}',
            '.wp-hs-mohawk .wp-hairback{display:block;left:43%;right:43%;bottom:74%;height:20%;border-radius:50% 50% 0 0}',
            '.wp-hs-spiky .wp-hairback{display:block;left:22%;right:22%;bottom:70%;height:20%;clip-path:polygon(0 100%,8% 20%,22% 70%,35% 0,50% 60%,65% 0,78% 70%,92% 20%,100% 100%)}',
            // the face (shown when they turn around)
            '.wp-face i{position:absolute;display:block;font-style:normal}',
            '.wp-eyes{left:24%;right:24%;top:44%;height:13%}',
            '.wp-eyes::before,.wp-eyes::after{content:"";position:absolute;top:0;height:100%;aspect-ratio:1;border-radius:50%;background:#1d1d1d}',
            '.wp-eyes::before{left:8%}.wp-eyes::after{right:8%}',
            '.wp-mouth{left:36%;right:36%;top:63%;height:11%;border-bottom:max(2px,calc(var(--s)*.03)) solid #6d2b2b;border-radius:0 0 50% 50%}',
            '.wp-fringe{left:-6%;right:-6%;top:-10%;height:40%;background:var(--hair);border-radius:50% 50% 35% 35%/85% 85% 25% 25%}',
            '.wp-hs-bald .wp-fringe{display:none}',
            '.wp-hs-mohawk .wp-fringe{left:40%;right:40%;border-radius:40%}',
            '.wp-hs-spiky .wp-fringe{clip-path:polygon(0 100%,0 30%,15% 0,30% 35%,50% 0,70% 35%,85% 0,100% 30%,100% 100%)}',
            '.wp-hs-long .wp-fringe,.wp-hs-curly .wp-fringe{height:46%}',
            '.wp-photo{inset:0;display:none!important;border-radius:50%;overflow:hidden}',
            '.wp-usephoto .wp-photo{display:block!important}',
            '.wp-usephoto .wp-eyes,.wp-usephoto .wp-mouth,.wp-usephoto .wp-fringe{display:none}',
            '.wp-face .wp-specs{display:none;left:12%;right:12%;top:38%;height:24%}',
            '.wp-acc-glasses .wp-face .wp-specs,.wp-acc-shades .wp-face .wp-specs{display:block}',
            '.wp-specs::before,.wp-specs::after{content:"";position:absolute;top:0;width:38%;height:100%;border-radius:40%;border:max(2px,calc(var(--s)*.025)) solid #1d1d1d;box-sizing:border-box}',
            '.wp-specs::before{left:2%}.wp-specs::after{right:2%}',
            '.wp-acc-shades .wp-specs::before,.wp-acc-shades .wp-specs::after{background:#111}',
            // accessories on top of the head (seen from both sides)
            '.wp-acc{position:absolute;inset:0;pointer-events:none;z-index:2}',
            '.wp-acc::before,.wp-acc::after{content:"";position:absolute;display:none}',
            '.wp-acc-cap .wp-acc::before{display:block;left:22%;right:22%;bottom:70%;height:15%;border-radius:50% 50% 8% 8%/100% 100% 8% 8%;background:var(--top);filter:brightness(.85)}',
            '.wp-acc-cap .wp-acc::after{display:block;left:18%;right:38%;bottom:69%;height:4%;border-radius:50%;background:var(--top);filter:brightness(.65)}',
            '.wp-acc-beanie .wp-acc::before{display:block;left:22%;right:22%;bottom:68%;height:19%;border-radius:50% 50% 6% 6%/90% 90% 6% 6%;background:repeating-linear-gradient(90deg,#1e88e5 0 12%,#1565c0 12% 24%)}',
            '.wp-acc-beanie .wp-acc::after{display:block;left:45%;right:45%;bottom:84%;height:8%;border-radius:50%;background:#e3f2fd}',
            '.wp-acc-partyhat .wp-acc::before{display:block;left:36%;right:36%;bottom:76%;height:24%;clip-path:polygon(50% 0,100% 100%,0 100%);background:repeating-linear-gradient(135deg,#ff4081 0 14%,#ffd740 14% 28%,#40c4ff 28% 42%)}',
            '.wp-acc-crown .wp-acc::before{display:block;left:30%;right:30%;bottom:76%;height:13%;clip-path:polygon(0 100%,0 20%,20% 60%,35% 0,50% 55%,65% 0,80% 60%,100% 20%,100% 100%);background:linear-gradient(#ffe57f,#ffb300)}',
            '.wp-acc-catears .wp-acc::before,.wp-acc-catears .wp-acc::after{display:block;bottom:74%;width:15%;height:14%;clip-path:polygon(50% 0,100% 100%,0 100%);background:var(--hair)}',
            '.wp-acc-catears .wp-acc::before{left:25%;transform:rotate(-18deg)}.wp-acc-catears .wp-acc::after{right:25%;transform:rotate(18deg)}',
            '.wp-acc-headphones .wp-acc::before{display:block;left:20%;right:20%;bottom:58%;height:30%;border:max(2px,calc(var(--s)*.035)) solid #263238;border-bottom:0;border-radius:50% 50% 0 0/100% 100% 0 0;box-sizing:border-box}',
            '.wp-acc-headphones .wp-acc::after{display:block;left:16%;right:16%;bottom:53%;height:12%;background:radial-gradient(circle at 6% 50%,#e53935 0 8%,transparent 9%),radial-gradient(circle at 94% 50%,#e53935 0 8%,transparent 9%)}',
            '.wp-head{position:absolute;left:24%;right:24%;bottom:40%;aspect-ratio:1;transform-style:preserve-3d;transition:transform .45s ease}',
            '.wp-head>div{position:absolute;inset:0;border-radius:50%;backface-visibility:hidden;-webkit-backface-visibility:hidden;overflow:hidden}',
            '.wp-hair{background:radial-gradient(circle at 50% 35%,rgba(255,255,255,.12),rgba(0,0,0,0) 60%),var(--hair);box-shadow:inset 0 -3px 6px rgba(0,0,0,.35)}',
            '.wp-face{transform:rotateY(180deg);background:var(--skin);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:calc(var(--s)*.22)}',
            '.wp-face img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
            '.wp-seat.wp-turn .wp-head{transform:rotateY(180deg)}',
            '.wp-seat.wp-up .wp-fig{transform:translateY(-38%)}',
            '.wp-seat.wp-up .wp-chair{z-index:0}',
            '.wp-name{position:absolute;left:50%;bottom:16%;transform:translateX(-50%);white-space:nowrap;font-size:calc(var(--s)*.17);color:#fff;text-shadow:0 1px 3px #000;opacity:0;transition:opacity .3s;z-index:4}',
            '.wp-seat.wp-up .wp-name,.wp-seat.wp-talk .wp-name,.wp-mini .wp-name{opacity:.9}',
            '.wp-mini .wp-name{bottom:auto;top:calc(100% - 1.4em);font-size:.62em;z-index:5}',
            '.wp-seat.wp-away .wp-fig{opacity:.0}',
            '.wp-seat.wp-away .wp-chair::before{content:"BRB";position:absolute;left:0;right:0;top:-55%;text-align:center;font-size:calc(var(--s)*.18);font-weight:700;color:#ffd54f;text-shadow:0 1px 3px #000}',
            '.wp-seat.wp-ghost .wp-fig{opacity:.45}',
            '.wp-seat.wp-host .wp-chair{background:linear-gradient(180deg,#b8862b 0%,#8a5d14 55%,#4a3007 100%)}',
            '.wp-emoji{position:absolute;left:50%;bottom:95%;transform:translateX(-50%);font-size:calc(var(--s)*.55);pointer-events:none;z-index:5;line-height:1}',
            '.wp-emoji.wp-go{animation:wp-float 2.4s ease-out forwards}',
            '@keyframes wp-float{0%{opacity:0;transform:translate(-50%,20%) scale(.5)}15%{opacity:1;transform:translate(-50%,-10%) scale(1.15)}70%{opacity:1}100%{opacity:0;transform:translate(-50%,-140%) scale(1)}}',
            '.wp-bubble{position:absolute;left:50%;bottom:calc(100% + .5em);transform:translateX(-50%);max-width:calc(var(--s)*3.2);width:max-content;background:#fff;color:#111;border-radius:.8em;padding:.35em .6em;font-size:max(12px,calc(var(--s)*.16));line-height:1.25;box-shadow:0 4px 14px rgba(0,0,0,.5);z-index:6;opacity:0;transition:opacity .25s;overflow-wrap:anywhere}',
            '.wp-bubble::after{content:"";position:absolute;left:50%;top:100%;transform:translateX(-50%);border:.4em solid transparent;border-top-color:#fff}',
            '.wp-seat.wp-talk .wp-bubble{opacity:1}',
            // emote moves
            '.wp-seat.wp-e-laugh .wp-fig{animation:wp-shake .25s 6}',
            '.wp-seat.wp-e-clap .wp-fig,.wp-seat.wp-e-popcorn .wp-fig{animation:wp-hop .35s 5}',
            '.wp-seat.wp-e-cheer .wp-fig{animation:wp-jump .5s 3}',
            '.wp-seat.wp-e-scared .wp-fig{animation:wp-tremble .08s 20}',
            '.wp-seat.wp-e-sad .wp-head{transform:rotateY(180deg) rotateZ(14deg) translateY(10%)}',
            '.wp-seat.wp-e-love .wp-fig{animation:wp-sway 1s 2}',
            '.wp-seat.wp-e-boo .wp-fig{animation:wp-lean 1.2s 2}',
            '.wp-seat.wp-e-wow .wp-head{transform:rotateY(180deg) scale(1.15)}',
            '.wp-seat.wp-e-pause .wp-fig{animation:wp-hop .5s 3}',
            '@keyframes wp-shake{0%,100%{transform:translateY(-38%) rotate(0)}25%{transform:translateY(-38%) rotate(-7deg)}75%{transform:translateY(-38%) rotate(7deg)}}',
            '@keyframes wp-hop{0%,100%{transform:translateY(-38%)}50%{transform:translateY(-48%)}}',
            '@keyframes wp-jump{0%,100%{transform:translateY(-38%)}45%{transform:translateY(-80%) scale(1.05)}}',
            '@keyframes wp-tremble{0%,100%{transform:translate(-2%,-30%)}50%{transform:translate(2%,-30%)}}',
            '@keyframes wp-sway{0%,100%{transform:translateY(-38%) rotate(0)}30%{transform:translateY(-38%) rotate(-8deg)}70%{transform:translateY(-38%) rotate(8deg)}}',
            '@keyframes wp-lean{0%,100%{transform:translateY(-38%) rotate(0)}50%{transform:translateY(-30%) rotate(-14deg)}}',

            // full screen mode: avatars pop in from the corner when they react
            '.wp-pops{position:absolute;left:3%;bottom:16%;z-index:3;pointer-events:none;display:flex;flex-direction:column-reverse;gap:.5em;--s:min(7vw,11vh)}',
            '.wp-theater .wp-pops{bottom:34%}',
            '.wp-pop{display:flex;align-items:flex-end;gap:.5em;animation:wp-popin .35s ease-out}',
            '.wp-pop.wp-pop-out{opacity:0;transform:translateX(-30%);transition:all .4s}',
            '.wp-pop .wp-seat{height:calc(var(--s)*1.1)}',
            '.wp-pop .wp-chair{display:none}',
            '.wp-pop .wp-fig{bottom:0;transform:none!important}',
            '.wp-pop-text{background:rgba(0,0,0,.72);color:#fff;border-radius:.7em;padding:.4em .7em;font-size:max(13px,calc(var(--s)*.2));max-width:40vw;margin-bottom:.6em;overflow-wrap:anywhere}',
            '@keyframes wp-popin{from{opacity:0;transform:translateX(-40%)}to{opacity:1;transform:none}}',

            // the rail of party buttons in the player
            '.wp-rail{position:fixed;right:12px;top:50%;transform:translateY(-50%);z-index:100000;display:flex;flex-direction:column;align-items:center;gap:.25em;padding:.4em .3em;border-radius:2em;background:rgba(10,10,10,.62);backdrop-filter:blur(6px);transition:opacity .3s,transform .3s;max-height:calc(100vh - 140px);overflow-y:auto;scrollbar-width:none}',
            '.wp-rail.wp-hidden{opacity:0;pointer-events:none;transform:translate(30%,-50%)}',
            '.wp-rail .wp-react{font-size:1.45em}',
            '.wp-rail hr{width:60%;border:0;border-top:1px solid rgba(255,255,255,.18);margin:.2em 0}',
            '.wp-rail .wp-icon-btn{background:transparent;font-size:1.15em;width:2.1em;height:2.1em}',
            '.wp-rail .wp-icon-btn:hover{background:rgba(255,255,255,.15)}',
            '.wp-chatbox{position:fixed;right:calc(12px + 3.4em);top:50%;transform:translateY(-50%);z-index:100001;display:flex;gap:.4em;background:#181818;padding:.5em;border-radius:2em;box-shadow:0 6px 24px rgba(0,0,0,.6);width:min(22em,calc(100vw - 6em))}',
            '.wp-chatbox input{flex:1;min-width:0;font:inherit;padding:.45em .8em;border-radius:2em;border:1px solid rgba(255,255,255,.15);background:#0f0f0f;color:#eee}',
            '.wp-viewbtn{position:fixed;left:50%;top:4.6em;transform:translateX(-50%);z-index:100000;font:inherit;font-size:.95rem;padding:.55em 1.1em;border-radius:2em;border:1px solid rgba(255,255,255,.25);background:rgba(10,10,10,.7);color:#fff;cursor:pointer;backdrop-filter:blur(6px);transition:opacity .3s;white-space:pre}',
            '.wp-viewbtn:hover{background:rgba(0,164,220,.85)}',
            '.wp-viewbtn:focus-visible{outline:2px solid #fff;outline-offset:2px}',
            '.wp-viewbtn.wp-hidden{opacity:0;pointer-events:none}',
            '.wp-view{display:flex;margin:0 1em .3em;border-radius:2em;background:rgba(255,255,255,.07);padding:3px}',
            '.wp-view button{flex:1;font:inherit;font-size:.88em;padding:.4em .6em;border:0;border-radius:2em;background:transparent;color:inherit;cursor:pointer;opacity:.7}',
            '.wp-view button.wp-on{background:#00a4dc;color:#fff;opacity:1;font-weight:600}',
            '.wp-view button:focus-visible{outline:2px solid #fff;outline-offset:2px}',
            '.wp-editor{max-width:40em}',
            '.wp-ed-body{display:flex;gap:1em;padding:0 1.1em;overflow-y:auto;flex-wrap:wrap}',
            '.wp-ed-stage{flex:0 0 12em;position:relative;min-height:15em;border-radius:.6em;background:radial-gradient(ellipse at 50% 20%,#3a2424,#120909 70%);display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding-bottom:.8em;--s:7.5em}',
            '.wp-ed-stage .wp-seat{margin-bottom:1em}',
            '.wp-ed-stage .wp-chair{display:none}',
            '.wp-ed-stage .wp-name{display:none}',
            '.wp-ed-stage .wp-fig{bottom:0}',
            '.wp-ed-turn{font-size:.85em;padding:.35em .9em}',
            '.wp-ed-opts{flex:1 1 16em;min-width:0;display:flex;flex-direction:column;gap:.7em;padding-bottom:.5em}',
            '.wp-ed-group h4{margin:0 0 .35em;font-size:.8em;font-weight:600;text-transform:uppercase;letter-spacing:.06em;opacity:.6}',
            '.wp-swatches{display:flex;flex-wrap:wrap;gap:.35em}',
            '.wp-swatch{width:1.7em;height:1.7em;border-radius:50%;border:2px solid rgba(255,255,255,.15);cursor:pointer;padding:0}',
            '.wp-swatch.wp-on{border-color:#fff;box-shadow:0 0 0 2px #00a4dc}',
            '.wp-chips{display:flex;flex-wrap:wrap;gap:.35em}',
            '.wp-chip{font:inherit;font-size:.82em;padding:.35em .75em;border-radius:2em;border:1px solid rgba(255,255,255,.18);background:transparent;color:inherit;cursor:pointer}',
            '.wp-chip.wp-on{background:#00a4dc;border-color:#00a4dc;color:#fff;font-weight:600}',
            '.wp-swatch:focus-visible,.wp-chip:focus-visible{outline:2px solid #fff;outline-offset:2px}',
            '.wp-ed-photo{display:flex;align-items:center;gap:.5em;font-size:.9em;cursor:pointer}',
            '.wp-ed-photo input{width:1.1em;height:1.1em;accent-color:#00a4dc;margin:0}',
            '.wp-linkbtn{font:inherit;font-size:.88em;background:none;border:0;color:#00a4dc;cursor:pointer;padding:.3em 1.35em 0;text-align:left}',
            '.wp-update{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:100004;display:flex;align-items:center;gap:.6em;background:#1d1d1d;color:#eee;padding:.5em .6em .5em 1em;border-radius:2em;box-shadow:0 6px 24px rgba(0,0,0,.6);max-width:calc(100vw - 32px)}',
            '.wp-update .wp-btn{padding:.35em .9em;font-size:.9em}',
            '.wp-mic{margin-left:.35em;font-size:.85em}',
            '.wp-member.wp-speaking .wp-avatar{box-shadow:0 0 0 2px #4caf50,0 0 10px #4caf50}',
            '.wp-rail .wp-mic-live{background:rgba(76,175,80,.35)}',
            '.wp-voice-audio{display:none}',
            '.wp-seat.wp-speaking .wp-head{animation:wp-bob .32s ease-in-out infinite alternate}',
            '.wp-seat.wp-speaking .wp-mouth{height:15%;top:62%;background:#5a1f1f;border-radius:45%;border:0;animation:wp-mouth .16s infinite alternate}',
            '.wp-seat.wp-speaking .wp-fig::after{content:"🔊";position:absolute;right:4%;bottom:78%;font-size:calc(var(--s)*.2);z-index:5;animation:wp-blink 1s infinite}',
            '.wp-seat.wp-speaking.wp-turn .wp-head{animation:none}',
            '@keyframes wp-bob{from{translate:0 0}to{translate:0 -4%}}',
            '@keyframes wp-mouth{from{transform:scaleY(.35)}to{transform:scaleY(1)}}',
            '.wp-banner{position:absolute;left:50%;top:14%;transform:translateX(-50%);z-index:3;background:rgba(0,0,0,.7);color:#fff;padding:.5em 1em;border-radius:2em;font-size:.95em;pointer-events:none;white-space:nowrap}',
            '@media (max-width:600px){.wp-stage-row{left:0;right:0;--s:10.5vw}.wp-theater video{left:3%!important;width:94%!important}.wp-curtain{width:4%}}'
        ].join('\n');
        var s = document.createElement('style');
        s.id = 'wp-styles';
        s.textContent = css;
        document.head.appendChild(s);
    }

    // ---------- seats ----------

    function seatHtml(i) {
        return '<div class="wp-seat wp-empty-seat" data-seat="' + i + '">' +
            '<div class="wp-fig"><div class="wp-emoji"></div><div class="wp-bubble"></div>' +
            '<div class="wp-hairback"></div><div class="wp-torso"><i class="wp-neck"></i></div>' +
            '<div class="wp-head"><div class="wp-hair"></div><div class="wp-face"><i class="wp-eyes"></i><i class="wp-mouth"></i>' +
            '<i class="wp-photo"></i><i class="wp-fringe"></i><i class="wp-specs"></i></div></div><div class="wp-acc"></div></div>' +
            '<div class="wp-chair"></div><div class="wp-name"></div></div>';
    }

    function rowHtml() {
        var h = '<div class="wp-row">';
        for (var i = 0; i < SEATS; i++) h += seatHtml(i);
        return h + '</div>';
    }

    function dressSeat(seat, m) {
        var key = m ? [m.UserId, m.Name, m.ImageTag, m.Status, m.IsHost, JSON.stringify(m.Avatar || null)].join('|') : '';
        if (seat.getAttribute('data-key') === key) return;
        seat.setAttribute('data-key', key);
        seat.setAttribute('data-user', m ? m.UserId : '');
        seat.classList.toggle('wp-empty-seat', !m);
        seat.classList.toggle('wp-away', !!m && (m.Status === 'away' || m.Status === 'offline'));
        seat.classList.toggle('wp-ghost', !!m && m.Status === 'joining');
        seat.classList.toggle('wp-host', !!m && m.IsHost);
        seat.classList.toggle('wp-speaking', !!m && !!V.speaking[m.UserId]);
        if (!m) return;
        dressLook(seat, m.Avatar || defaultLook(m.Name), userImage(m.UserId, m.ImageTag, 80), hue(m.Name) % 99);
        seat.querySelector('.wp-name').textContent = m.Name + (m.IsHost ? ' 🎬' : '') + (m.Status === 'away' ? ' (stepped out)' : m.Status === 'offline' ? ' (offline)' : '');
    }

    function dressLook(seat, look, photo, number) {
        seat.style.setProperty('--skin', look.Skin);
        seat.style.setProperty('--hair', look.HairStyle === 'bald' ? look.Skin : look.HairColor);
        seat.style.setProperty('--top', look.TopColor);
        seat.className = seat.className.replace(/\bwp-(hs|top|acc)-\w+/g, '').replace(/\s+/g, ' ').trim();
        seat.classList.add('wp-hs-' + look.HairStyle, 'wp-top-' + look.Top, 'wp-acc-' + look.Accessory);
        seat.querySelector('.wp-torso').setAttribute('data-num', String(number || 7));
        var ph = seat.querySelector('.wp-photo');
        var showPhoto = !!(look.UsePhoto && photo);
        seat.classList.toggle('wp-usephoto', showPhoto);
        if (ph.getAttribute('data-src') === (showPhoto ? photo : '')) return;
        ph.setAttribute('data-src', showPhoto ? photo : '');
        ph.innerHTML = '';
        if (showPhoto) {
            // No picture after all: fall back to the cartoon face.
            var img = document.createElement('img');
            img.alt = '';
            img.onerror = function () { seat.classList.remove('wp-usephoto'); img.remove(); };
            img.src = photo;
            ph.appendChild(img);
        }
    }

    function fillRow(row, members) {
        var bySeat = {};
        members.forEach(function (m) { bySeat[m.Seat] = m; });
        row.querySelectorAll('.wp-seat').forEach(function (seat) {
            dressSeat(seat, bySeat[seat.getAttribute('data-seat')]);
        });
    }

    function allSeats(userId) {
        return document.querySelectorAll('.wp-seat[data-user="' + userId + '"]');
    }

    // Avatars stand up, turn around to face you, and act out the reaction, like on the 360.
    function emote(userId, key) {
        var r = REACTION[key];
        if (!r) return;
        allSeats(userId).forEach(function (seat) { emoteSeat(seat, key); });
    }

    function emoteSeat(seat, key) {
        var r = REACTION[key];
        clearTimeout(seat.__emoteTimer);
        seat.className = seat.className.replace(/\bwp-e-\w+/g, '');
        var em = seat.querySelector('.wp-emoji');
        em.classList.remove('wp-go');
        void em.offsetWidth;
        em.textContent = r.emoji;
        em.classList.add('wp-go');
        seat.classList.add('wp-up', 'wp-turn', 'wp-e-' + key);
        seat.__emoteTimer = setTimeout(function () {
            seat.classList.remove('wp-up', 'wp-e-' + key);
            if (!seat.classList.contains('wp-talk') && !seat.closest('.wp-ed-stage')) seat.classList.remove('wp-turn');
        }, 2600);
    }

    function say(userId, text) {
        allSeats(userId).forEach(function (seat) {
            clearTimeout(seat.__talkTimer);
            seat.querySelector('.wp-bubble').textContent = text;
            seat.classList.add('wp-talk', 'wp-turn');
            seat.__talkTimer = setTimeout(function () {
                seat.classList.remove('wp-talk');
                if (!seat.classList.contains('wp-up')) seat.classList.remove('wp-turn');
            }, 5500);
        });
    }

    // ---------- events from the party ----------

    function handleEvent(e, live) {
        var m = member(e.UserId);
        var name = m ? m.Name : 'Someone';
        var r = e.Type === 'react' ? REACTION[e.Text] : null;
        if (e.Type === 'chat') {
            logLine('<b>' + esc(name) + '</b> ' + esc(e.Text));
        } else if (r && e.Text === 'pause') {
            logLine('<span class="wp-sys">✋ ' + esc(name) + ' asked to pause</span>');
        } else if (e.Type !== 'react') {
            logLine('<span class="wp-sys">' + esc(e.Text) + '</span>');
        }
        if (!live) return;

        if (r) {
            emote(e.UserId, e.Text);
            popReaction(m, r.emoji + (e.Text === 'pause' ? ' asked to pause' : ''));
            pillPop(r.emoji);
            if (e.Text === 'pause' && S.party && S.party.IsHost) toast('✋ ' + name + ' asked to pause');
        } else if (e.Type === 'chat') {
            say(e.UserId, e.Text);
            popReaction(m, e.Text);
        } else if (e.Type === 'hint') {
            toast(e.Text);
        } else if (onPlayer()) {
            popReaction(m, e.Text, true);
        } else if (e.Type === 'join' || e.Type === 'leave' || e.Type === 'system') {
            if (!(m && m.IsMe)) toast(e.Text);
        }
    }

    function logLine(html) {
        S.chat.push(html);
        if (S.chat.length > 60) S.chat.shift();
        var log = document.querySelector('.wp-panel .wp-log');
        if (log) {
            log.appendChild(el('<div>' + html + '</div>'));
            while (log.children.length > 60) log.firstChild.remove();
            log.scrollTop = log.scrollHeight;
        }
    }

    // ---------- polling ----------

    var pollTimer = null;
    var polling = false;

    function schedule(ms) {
        clearTimeout(pollTimer);
        pollTimer = setTimeout(poll, ms);
    }

    function poll() {
        if (polling) return;
        var a = client();
        if (!a) { schedule(3000); return; }
        polling = true;
        var since = S.partyId ? S.seq : 0;
        call('GET', 'State?since=' + since).then(apply).catch(function () { /* try again next time */ }).then(function () {
            polling = false;
            schedule(voiceConnecting() ? 300 : S.party || onPlayer() ? 1000 : 4000);
        });
    }

    function apply(st) {
        S.clockOffset = Date.parse(st.ServerTime) - Date.now();
        if (st.EndedNote) toast(st.EndedNote);

        var prev = S.party;
        var p = st.Party;
        if (p && p.Id !== S.partyId) {
            // A different party: start its event feed from the beginning, without replaying old reactions.
            S.partyId = p.Id;
            S.seq = 0;
            S.chat = [];
            S.primed = false;
        }
        S.party = p;

        if (p) {
            var serverNow = Date.parse(st.ServerTime);
            p.Events.forEach(function (e) {
                if (e.Seq <= S.seq) return;
                S.seq = e.Seq;
                handleEvent(e, S.primed && serverNow - Date.parse(e.At) < 10000);
            });
            S.primed = true;
        } else if (prev) {
            S.partyId = null;
            S.seq = 0;
            S.panelOpen = false;
        }

        S.invites = st.Invites.filter(function (i) { return !S.dismissed[i.PartyId]; });
        if (st.Version && VERSION.indexOf('WP_VERSION') === -1 && st.Version !== VERSION) offerRefresh();
        syncVoice(p);
        render();
    }

    // The page keeps running the script it loaded with, so after a plugin update, say so.
    function offerRefresh() {
        if (document.querySelector('.wp-update')) return;
        var bar = el('<div class="wp-update" role="status">Watch Party was updated. ' +
            '<button type="button" class="wp-btn wp-btn-primary">Refresh</button><button type="button" class="wp-btn" aria-label="Later">Later</button></div>');
        bar.querySelector('.wp-btn-primary').onclick = function () { location.reload(); };
        bar.querySelectorAll('.wp-btn')[1].onclick = function () { bar.style.display = 'none'; };
        document.body.appendChild(bar);
    }

    // ---------- voice chat ----------
    // Browsers talk to each other directly (WebRTC). The server only passes the setup messages along.

    var V = { on: false, muted: false, joining: false, stream: null, peers: {}, chain: Promise.resolve(), ctx: null, meters: {}, speaking: {}, ice: [], duck: null, rejoinAt: 0 };

    function voiceSupported() {
        return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    function voiceConnecting() {
        if (!V.on) return false;
        for (var id in V.peers) {
            var st = V.peers[id].pc.connectionState;
            if (st !== 'connected' && st !== 'failed' && st !== 'closed') return true;
        }
        return false;
    }

    function myId() {
        var me = S.party && S.party.Members.filter(function (m) { return m.IsMe; })[0];
        return me ? me.UserId : null;
    }

    function joinVoice() {
        if (V.on || V.joining) return;
        if (!window.isSecureContext) {
            toast('Voice chat needs Jellyfin over https (or localhost) so the browser can use your microphone.');
            return;
        }
        if (!voiceSupported()) { toast('This browser can’t do voice chat.'); return; }
        V.joining = true;
        // Created during the click, so the browser lets it play sound.
        try { V.ctx = V.ctx || new (window.AudioContext || window.webkitAudioContext)(); V.ctx.resume(); } catch (e) { V.ctx = null; }
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }).then(function (stream) {
            V.stream = stream;
            V.muted = false;
            return call('POST', 'Voice', { Join: true, Muted: false }).then(function () {
                V.on = true;
                V.joining = false;
                meter(myId(), stream, true);
                toast('You’re in voice chat. Headphones stop the movie echoing back.');
                poll();
                render();
            });
        }).catch(function (err) {
            V.joining = false;
            if (V.stream) { V.stream.getTracks().forEach(function (t) { t.stop(); }); V.stream = null; }
            fail(err && err.name === 'NotAllowedError' ? new Error('Microphone access was blocked. Allow it in the address bar, then try again.') : err);
            render();
        });
    }

    function leaveVoice(tellServer) {
        if (!V.on && !V.joining) return;
        Object.keys(V.peers).forEach(closePeer);
        Object.keys(V.meters).forEach(stopMeter);
        if (V.stream) V.stream.getTracks().forEach(function (t) { t.stop(); });
        V.stream = null;
        V.on = false;
        V.joining = false;
        V.muted = false;
        unduck();
        if (tellServer !== false) call('POST', 'Voice', { Join: false, Muted: false }).catch(function () { });
        render();
    }

    function toggleMute() {
        if (!V.on) return joinVoice();
        V.muted = !V.muted;
        V.stream.getAudioTracks().forEach(function (t) { t.enabled = !V.muted; });
        call('POST', 'Voice', { Join: true, Muted: V.muted }).catch(function () { });
        toast(V.muted ? 'Muted' : 'Unmuted');
        render();
    }

    function send(to, kind, data) {
        return call('POST', 'Signal', { To: to, Kind: kind, Data: data ? JSON.stringify(data) : '' }).catch(function () { });
    }

    function syncVoice(p) {
        if (!V.on) return;
        if (!p || !p.OnThisDevice) { leaveVoice(!!p); return; }
        V.ice = (p.IceServers || []).map(function (i) {
            var o = { urls: i.Urls };
            if (i.Username) o.username = i.Username;
            if (i.Credential) o.credential = i.Credential;
            return o;
        });
        var me = myId();
        var self = member(me);
        // The server forgot us (it restarted, or we moved device): sign back in.
        if (self && !self.InVoice && Date.now() > V.rejoinAt) {
            V.rejoinAt = Date.now() + 5000;
            call('POST', 'Voice', { Join: true, Muted: V.muted }).catch(function () { });
        }
        (p.Signals || []).forEach(function (sig) {
            V.chain = V.chain.then(function () { return onSignal(sig); }).catch(function () { });
        });
        var inVoice = {};
        p.Members.forEach(function (m) {
            if (m.IsMe || !m.InVoice) return;
            inVoice[m.UserId] = true;
            // One side calls, the other answers: the lower id makes the call.
            if (!V.peers[m.UserId] && me && me < m.UserId) V.chain = V.chain.then(function () { return call0(m.UserId); });
        });
        Object.keys(V.peers).forEach(function (id) { if (!inVoice[id]) closePeer(id); });
    }

    function newPeer(id) {
        var pc = new RTCPeerConnection({ iceServers: V.ice });
        var peer = { pc: pc, pending: [], audio: null, started: Date.now() };
        V.peers[id] = peer;
        V.stream.getTracks().forEach(function (t) { pc.addTrack(t, V.stream); });
        pc.onicecandidate = function (e) { if (e.candidate) send(id, 'ice', e.candidate.toJSON()); };
        pc.ontrack = function (e) {
            var stream = e.streams[0] || new MediaStream([e.track]);
            if (!peer.audio) {
                peer.audio = document.createElement('audio');
                peer.audio.autoplay = true;
                peer.audio.className = 'wp-voice-audio';
                document.body.appendChild(peer.audio);
            }
            peer.audio.srcObject = stream;
            peer.audio.play().catch(function () { });
            meter(id, stream, false);
        };
        pc.onconnectionstatechange = function () {
            if (pc.connectionState === 'failed') {
                closePeer(id);
                // The caller tries again; the other side waits for a fresh call.
                if (myId() < id) setTimeout(function () { if (V.on && !V.peers[id]) syncVoice(S.party); }, 4000);
            }
            render();
        };
        return peer;
    }

    function call0(id) {
        if (!V.on || V.peers[id]) return;
        var peer = newPeer(id);
        return peer.pc.createOffer().then(function (o) { return peer.pc.setLocalDescription(o); }).then(function () {
            return send(id, 'offer', peer.pc.localDescription.toJSON());
        });
    }

    function onSignal(sig) {
        if (!V.on) return;
        var id = sig.From, peer = V.peers[id];
        var data = sig.Data ? JSON.parse(sig.Data) : null;
        if (sig.Kind === 'bye') { closePeer(id); return; }
        if (sig.Kind === 'offer') {
            if (peer) closePeer(id);
            peer = newPeer(id);
            return peer.pc.setRemoteDescription(data).then(function () {
                return flushIce(peer);
            }).then(function () { return peer.pc.createAnswer(); }).then(function (a) { return peer.pc.setLocalDescription(a); }).then(function () {
                return send(id, 'answer', peer.pc.localDescription.toJSON());
            });
        }
        if (!peer) return;
        if (sig.Kind === 'answer') {
            if (peer.pc.signalingState !== 'have-local-offer') return;
            return peer.pc.setRemoteDescription(data).then(function () { return flushIce(peer); });
        }
        if (sig.Kind === 'ice') {
            if (peer.pc.remoteDescription) return peer.pc.addIceCandidate(data).catch(function () { });
            peer.pending.push(data);
        }
    }

    function flushIce(peer) {
        var list = peer.pending;
        peer.pending = [];
        return Promise.all(list.map(function (c) { return peer.pc.addIceCandidate(c).catch(function () { }); }));
    }

    function closePeer(id) {
        var peer = V.peers[id];
        if (!peer) return;
        delete V.peers[id];
        try { peer.pc.close(); } catch (e) { /* already closed */ }
        if (peer.audio) peer.audio.remove();
        stopMeter(id);
    }

    // Who's talking: their avatar's mouth moves, and the movie dips so you can hear them.
    function meter(id, stream, isMe) {
        if (!V.ctx || !id) return;
        stopMeter(id);
        try {
            var src = V.ctx.createMediaStreamSource(stream);
            var an = V.ctx.createAnalyser();
            an.fftSize = 512;
            src.connect(an);
            var buf = new Uint8Array(an.fftSize);
            var quietSince = 0;
            var timer = setInterval(function () {
                an.getByteTimeDomainData(buf);
                var sum = 0;
                for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
                var loud = Math.sqrt(sum / buf.length) > 0.035 && !(isMe && V.muted);
                var now = Date.now();
                if (loud) quietSince = 0; else if (!quietSince) quietSince = now;
                setSpeaking(id, loud || (quietSince && now - quietSince < 350), isMe);
            }, 100);
            V.meters[id] = { timer: timer, src: src };
        } catch (e) { /* no meter, voice still works */ }
    }

    function stopMeter(id) {
        var m = V.meters[id];
        if (!m) return;
        clearInterval(m.timer);
        try { m.src.disconnect(); } catch (e) { /* gone */ }
        delete V.meters[id];
        setSpeaking(id, false, false);
    }

    function setSpeaking(id, on, isMe) {
        on = !!on;
        if (!!V.speaking[id] === on) return;
        V.speaking[id] = on;
        allSeats(id).forEach(function (seat) { seat.classList.toggle('wp-speaking', on); });
        document.querySelectorAll('.wp-member[data-user="' + id + '"]').forEach(function (row) { row.classList.toggle('wp-speaking', on); });
        if (!isMe) updateDuck();
    }

    function updateDuck() {
        var me = myId();
        var anyone = Object.keys(V.speaking).some(function (id) { return id !== me && V.speaking[id]; });
        var c = playerContainer();
        var video = c && c.querySelector('video');
        if (anyone && video && !V.duck && readPref('wp-duck', 'on') === 'on') {
            V.duck = { video: video, from: video.volume, to: Math.round(video.volume * 35) / 100 };
            video.volume = V.duck.to;
        } else if (!anyone) {
            clearTimeout(V.unduckTimer);
            V.unduckTimer = setTimeout(function () {
                if (!Object.keys(V.speaking).some(function (id) { return id !== myId() && V.speaking[id]; })) unduck();
            }, 900);
        }
    }

    function unduck() {
        var d = V.duck;
        V.duck = null;
        // Only put the volume back if nobody changed it meanwhile.
        if (d && Math.abs(d.video.volume - d.to) < 0.01) d.video.volume = d.from;
    }

    // ---------- top-level render ----------

    var wasOnPlayer = false;

    function render() {
        if (!client()) return;
        // When the movie starts, get the party panel out of the way.
        var nowOnPlayer = onPlayer();
        if (nowOnPlayer && !wasOnPlayer) S.panelOpen = false;
        wasOnPlayer = nowOnPlayer;
        addStyles();
        renderInvites();
        renderPill();
        renderPanel();
        renderPlayer();
        ensureDetailButton();
    }

    // ---------- invites ----------

    var devicesCache = { at: 0, list: [] };
    function getDevices() {
        if (Date.now() - devicesCache.at < 20000) return Promise.resolve(devicesCache.list);
        return call('GET', 'Devices').then(function (d) { devicesCache = { at: Date.now(), list: d }; return d; }).catch(function () { return []; });
    }

    function deviceSelect(list) {
        if (list.length < 2) return '';
        return '<select class="wp-device" aria-label="Watch on">' + list.map(function (d) {
            return '<option value="' + esc(d.DeviceId) + '">' + esc(d.IsCurrent ? 'This device' : d.Name + (d.Client ? ' (' + d.Client + ')' : '')) + '</option>';
        }).join('') + '</select>';
    }

    function renderInvites() {
        var box = document.querySelector('.wp-invites');
        if (!S.invites.length) {
            if (box) box.remove();
            return;
        }
        if (!box) {
            box = el('<div class="wp-invites" aria-live="polite"></div>');
            document.body.appendChild(box);
        }
        var want = S.invites.map(function (i) { return i.PartyId; });
        box.querySelectorAll('.wp-invite').forEach(function (c) {
            if (want.indexOf(c.getAttribute('data-id')) === -1) c.remove();
        });
        S.invites.forEach(function (inv) {
            if (box.querySelector('.wp-invite[data-id="' + inv.PartyId + '"]')) return;
            var poster = itemImage(inv.ItemId, inv.ImageTag, 'Primary', 200);
            var card = el('<div class="wp-invite" role="alertdialog" aria-label="Watch party invite" data-id="' + esc(inv.PartyId) + '">' +
                '<div class="wp-invite-poster"' + (poster ? ' style="background-image:url(\'' + esc(poster) + '\')"' : '') + '></div>' +
                '<div class="wp-invite-body">' +
                '<div class="wp-invite-who">' + avatar(inv.HostId, inv.HostName, inv.HostImageTag, 22) + '<span><b>' + esc(inv.HostName) + '</b> invited you to a watch party</span></div>' +
                '<div class="wp-invite-title" title="' + esc(inv.ItemName) + '">' + esc(inv.ItemName) + '</div>' +
                '<div style="font-size:.8em;opacity:.65">' + inv.Watching + ' in the party · ' + (inv.Status === 'Lobby' ? 'starting soon' : 'already watching') + '</div>' +
                '<span class="wp-device-slot"></span>' +
                '<div class="wp-actions"><button type="button" class="wp-btn wp-btn-primary wp-join">Join</button>' +
                '<button type="button" class="wp-btn wp-later">Not now</button>' +
                '<button type="button" class="wp-btn wp-inv-avatar" title="Customize your avatar" aria-label="Customize your avatar">👤</button></div></div></div>');
            box.appendChild(card);
            getDevices().then(function (list) { card.querySelector('.wp-device-slot').innerHTML = deviceSelect(list); });
            card.querySelector('.wp-inv-avatar').onclick = openAvatarEditor;
            card.querySelector('.wp-later').onclick = function () {
                S.dismissed[inv.PartyId] = true;
                S.invites = S.invites.filter(function (i) { return i.PartyId !== inv.PartyId; });
                call('POST', 'Decline', { PartyId: inv.PartyId }).catch(function () { });
                renderInvites();
            };
            card.querySelector('.wp-join').onclick = function () {
                var sel = card.querySelector('.wp-device');
                this.disabled = true;
                call('POST', 'Join', { PartyId: inv.PartyId, DeviceId: sel ? sel.value : null }).then(function (st) {
                    S.panelOpen = !onPlayer();
                    apply(st);
                    toast(inv.Status === 'Lobby' ? 'You’re in! Waiting for ' + inv.HostName + ' to start' : 'You’re in! Catching you up…');
                }, function (err) {
                    S.dismissed[inv.PartyId] = true;
                    fail(err);
                    render();
                });
            };
        });
    }

    // ---------- pill + panel (outside the player) ----------

    function statusText(p) {
        if (p.Status === 'Lobby') {
            if (p.PositionTicks > 0) return 'Intermission at ' + clock(p.PositionTicks);
            var host = p.Members.filter(function (m) { return m.IsHost; })[0];
            return p.IsHost ? 'Waiting for you to start' : 'Waiting for ' + (host ? host.Name : 'the host');
        }
        return (p.Status === 'Paused' ? 'Paused at ' : 'Playing · ') + clock(p.PositionTicks) + (p.RunTimeTicks ? ' / ' + clock(p.RunTimeTicks) : '');
    }

    function renderPill() {
        var pill = document.querySelector('.wp-pill');
        var p = S.party;
        if (!p || S.panelOpen || onPlayer()) {
            if (pill) pill.remove();
            return;
        }
        var poster = itemImage(p.ItemId, p.ImageTag, 'Primary', 100);
        var watching = p.Members.length;
        var html = '<span class="wp-pill-poster"' + (poster ? ' style="background-image:url(\'' + esc(poster) + '\')"' : '') + '></span>' +
            '<span class="wp-pill-text"><b>' + (p.Status === 'Playing' ? '<span class="wp-live"></span>' : '') + esc(p.ItemName) + '</b>' +
            '<span>Watch party · ' + watching + (watching === 1 ? ' person' : ' people') + (p.IsAway ? ' · you stepped out' : '') + '</span></span>';
        if (!pill) {
            pill = el('<button type="button" class="wp-pill" aria-label="Open watch party"></button>');
            pill.onclick = function () { S.panelOpen = true; render(); };
            document.body.appendChild(pill);
        }
        if (pill.__html !== html) {
            pill.__html = html;
            var pops = pill.querySelectorAll('.wp-pill-pop');
            pill.innerHTML = html;
            pops.forEach(function (x) { pill.appendChild(x); });
        }
    }

    function pillPop(emoji) {
        var pill = document.querySelector('.wp-pill');
        if (!pill) return;
        var x = el('<span class="wp-pill-pop">' + emoji + '</span>');
        pill.appendChild(x);
        setTimeout(function () { x.remove(); }, 1900);
    }

    function closePanel() {
        S.panelOpen = false;
        var panel = document.querySelector('.wp-panel');
        if (panel) panel.remove();
        render();
    }

    function renderPanel() {
        var panel = document.querySelector('.wp-panel');
        var p = S.party;
        if (!p || !S.panelOpen) {
            if (panel) panel.remove();
            return;
        }
        if (!panel) {
            panel = el('<section class="wp-panel" role="dialog" aria-label="Watch party">' +
                '<div class="wp-panel-head"><h3></h3><div class="wp-subline"></div>' +
                '<button type="button" class="wp-icon-btn wp-close" aria-label="Minimize">✕</button></div>' +
                '<div class="wp-mini"><div class="wp-mini-screen"></div>' + rowHtml() + '</div>' +
                '<div class="wp-status"></div>' +
                '<div class="wp-controls"></div>' +
                '<div class="wp-view" role="radiogroup" aria-label="How the movie is shown">' +
                '<button type="button" role="radio" data-mode="theater">🎭 Theater</button>' +
                '<button type="button" role="radio" data-mode="full">⛶ Full screen</button></div>' +
                '<div class="wp-members"></div>' +
                '<div class="wp-reacts">' + REACTIONS.map(function (r) {
                    return '<button type="button" class="wp-react" data-r="' + r.key + '" title="' + esc(r.label) + '" aria-label="' + esc(r.label) + '">' + r.emoji + '</button>';
                }).join('') + '</div>' +
                '<div class="wp-log" aria-live="polite"></div>' +
                '<form class="wp-say"><input type="text" maxlength="140" placeholder="Say something…" aria-label="Chat message">' +
                '<button type="submit" class="wp-btn wp-btn-primary">Send</button></form></section>');
            panel.querySelector('.wp-close').onclick = closePanel;
            panel.querySelector('.wp-view').addEventListener('click', function (e) {
                var b = e.target.closest('[data-mode]');
                if (b) setMode(b.getAttribute('data-mode'));
            });
            panel.querySelector('.wp-reacts').addEventListener('click', onReactClick);
            panel.querySelector('.wp-say').addEventListener('submit', onChatSubmit);
            panel.addEventListener('keydown', function (e) { if (isBackKey(e)) { e.preventDefault(); e.stopPropagation(); closePanel(); } });
            panel.querySelector('.wp-log').innerHTML = S.chat.map(function (h) { return '<div>' + h + '</div>'; }).join('');
            document.body.appendChild(panel);
            panel.querySelector('.wp-log').scrollTop = 1e9;
            setTimeout(function () { var b = panel.querySelector('.wp-controls .wp-btn') || panel.querySelector('.wp-close'); if (b) b.focus(); }, 0);
        }

        var backdrop = itemImage(p.BackdropItemId || p.ItemId, p.BackdropTag, 'Backdrop', 360);
        var head = panel.querySelector('.wp-panel-head');
        head.style.backgroundImage = backdrop ? 'linear-gradient(180deg,rgba(0,0,0,.35),#181818),url("' + backdrop + '")' : '';
        setText(head.querySelector('h3'), p.ItemName);
        setText(head.querySelector('.wp-subline'), p.ItemSubtitle || '');
        var screen = panel.querySelector('.wp-mini-screen');
        screen.style.backgroundImage = backdrop ? 'url("' + backdrop + '")' : '';
        screen.style.filter = p.Status === 'Playing' ? '' : 'brightness(.45)';
        fillRow(panel.querySelector('.wp-mini .wp-row'), p.Members);
        setHtml(panel.querySelector('.wp-status'), (p.Status === 'Playing' ? '<span class="wp-live"></span>' : '') + esc(statusText(p)) +
            (!p.OnThisDevice && p.DeviceName ? '<div style="opacity:.6;font-size:.88em">Playing on ' + esc(p.DeviceName) + '</div>' : ''));

        panel.querySelectorAll('.wp-view [data-mode]').forEach(function (b) {
            var on = b.getAttribute('data-mode') === S.mode;
            b.classList.toggle('wp-on', on);
            if (b.getAttribute('aria-checked') !== String(on)) b.setAttribute('aria-checked', String(on));
        });

        // Controls
        var controls = [];
        if (p.IsHost && p.Status === 'Lobby') {
            if (p.PositionTicks > 0) {
                controls.push('<button type="button" class="wp-btn wp-btn-primary" data-act="resume">▶ Resume from ' + clock(p.PositionTicks) + '</button>');
                controls.push('<button type="button" class="wp-btn" data-act="restart">From the beginning</button>');
            } else {
                controls.push('<button type="button" class="wp-btn wp-btn-primary" data-act="restart">▶ Start the movie</button>');
            }
        }
        if (!p.IsHost && p.IsAway) controls.push('<button type="button" class="wp-btn wp-btn-primary" data-act="rejoin">Rejoin the movie</button>');
        if (p.Status !== 'Lobby' && !p.IsAway && p.OnThisDevice && !onPlayer()) controls.push('<button type="button" class="wp-btn wp-btn-primary" data-act="rejoin">Back to the movie</button>');
        if (p.Members.length < p.MaxMembers) controls.push('<button type="button" class="wp-btn" data-act="invite">Invite friends</button>');
        controls.push('<button type="button" class="wp-btn" data-act="avatar">👤 My avatar</button>');
        if (p.OnThisDevice && voiceSupported()) {
            if (!V.on) controls.push('<button type="button" class="wp-btn" data-act="voice"' + (V.joining ? ' disabled' : '') + '>🎙 Join voice chat</button>');
            else {
                controls.push('<button type="button" class="wp-btn' + (V.muted ? ' wp-btn-primary' : '') + '" data-act="mute">' + (V.muted ? '🔇 Unmute' : '🎙 Mute') + '</button>');
                controls.push('<button type="button" class="wp-btn" data-act="unvoice">Leave voice</button>');
            }
        }
        controls.push(p.IsHost
            ? '<button type="button" class="wp-btn wp-btn-danger" data-act="end">End party</button>'
            : '<button type="button" class="wp-btn wp-btn-danger" data-act="leave">Leave</button>');
        if (p.IsHost && p.Members.length > 1) controls.push('<button type="button" class="wp-btn" data-act="leave">Leave (pass host)</button>');
        var ctl = panel.querySelector('.wp-controls');
        var ctlHtml = controls.join('');
        if (ctl.__html !== ctlHtml) {
            ctl.__html = ctlHtml;
            ctl.innerHTML = ctlHtml;
            ctl.querySelectorAll('[data-act]').forEach(function (b) { b.onclick = function () { act(b.getAttribute('data-act'), b); }; });
        }

        // Members
        var STATUS = { watching: 'watching', joining: 'joining…', away: 'stepped out', offline: 'offline', lobby: 'in the lobby' };
        var mhtml = p.Members.map(function (m) {
            return '<div class="wp-member' + (V.speaking[m.UserId] ? ' wp-speaking' : '') + '" data-user="' + esc(m.UserId) + '">' + avatar(m.UserId, m.Name, m.ImageTag, 30) +
                '<div class="wp-name-col">' + esc(m.Name) + (m.IsMe ? ' (you)' : '') + (m.IsHost ? '<span class="wp-badge">HOST</span>' : '') +
                (m.InVoice ? '<span class="wp-mic" title="' + (m.Muted ? 'Muted' : 'In voice chat') + '">' + (m.Muted ? '🔇' : '🎙') + '</span>' : '') +
                '<small>' + esc(STATUS[m.Status] || m.Status) + (m.DeviceName ? ' · ' + esc(m.DeviceName) : '') + '</small></div>' +
                (p.IsHost && !m.IsMe && m.Status !== 'offline' ? '<button type="button" class="wp-btn" data-host="' + esc(m.UserId) + '" title="Pass the remote to ' + esc(m.Name) + '">Make host</button>' : '') +
                '</div>';
        }).join('') + p.Invited.map(function (u) {
            return '<div class="wp-member" style="opacity:.55">' + avatar(u.Id, u.Name, u.ImageTag, 30) +
                '<div class="wp-name-col">' + esc(u.Name) + '<small>invited</small></div></div>';
        }).join('');
        var mem = panel.querySelector('.wp-members');
        if (mem.__html !== mhtml) {
            mem.__html = mhtml;
            mem.innerHTML = mhtml;
            mem.querySelectorAll('[data-host]').forEach(function (b) {
                b.onclick = function () {
                    call('POST', 'Host', { UserId: b.getAttribute('data-host') }).then(poll, fail);
                };
            });
        }
    }

    function act(what, btn) {
        if (btn) btn.disabled = true;
        var done = function () { if (btn) btn.disabled = false; poll(); };
        var p = S.party;
        if (what === 'restart' || what === 'resume') {
            call('POST', 'Start', { FromBeginning: what === 'restart' }).then(function () {
                S.panelOpen = false;
                done();
            }, function (e) { fail(e); done(); });
        } else if (what === 'rejoin') {
            call('POST', 'Rejoin', {}).then(function () { S.panelOpen = false; done(); }, function (e) { fail(e); done(); });
        } else if (what === 'voice') {
            joinVoice();
        } else if (what === 'mute') {
            if (btn) btn.disabled = false;
            toggleMute();
        } else if (what === 'unvoice') {
            if (btn) btn.disabled = false;
            leaveVoice(true);
        } else if (what === 'avatar') {
            if (btn) btn.disabled = false;
            openAvatarEditor();
        } else if (what === 'invite') {
            if (btn) btn.disabled = false;
            openInvite(p.ItemId, p.ItemName, true);
        } else if (what === 'end' || what === 'leave') {
            leaveVoice(false);
        }
        if (what === 'end') {
            call('POST', 'End').then(function () { toast('Party ended'); done(); }, function (e) { fail(e); done(); });
        } else if (what === 'leave') {
            call('POST', 'Leave').then(function () { toast('You left the party'); done(); }, function (e) { fail(e); done(); });
        }
    }

    function onReactClick(e) {
        var b = e.target.closest('[data-r]');
        if (!b) return;
        var key = b.getAttribute('data-r');
        call('POST', 'React', { Reaction: key }).then(poll, fail);
    }

    function onChatSubmit(e) {
        e.preventDefault();
        var input = e.target.querySelector('input');
        var text = input.value.trim();
        if (!text) return;
        input.value = '';
        call('POST', 'Chat', { Text: text }).then(poll, function (err) { input.value = text; fail(err); });
    }

    // ---------- avatar editor ----------

    function openAvatarEditor() {
        var a = client();
        if (!a) return;
        Promise.all([
            call('GET', 'Avatar'),
            a.getCurrentUser ? a.getCurrentUser().catch(function () { return null; }) : Promise.resolve(null)
        ]).then(function (r) {
            var me = r[1] || {};
            var name = me.Name || '';
            var look = r[0] || defaultLook(name);
            var photo = me.PrimaryImageTag ? userImage(me.Id, me.PrimaryImageTag, 160) : null;
            var turned = true;

            function swatches(field, colors, label) {
                return '<div class="wp-ed-group"><h4>' + label + '</h4><div class="wp-swatches" role="radiogroup" aria-label="' + label + '">' + colors.map(function (c) {
                    return '<button type="button" class="wp-swatch" role="radio" data-f="' + field + '" data-v="' + c + '" style="background:' + c + '" aria-label="' + c + '"></button>';
                }).join('') + '</div></div>';
            }
            function chips(field, options, label) {
                return '<div class="wp-ed-group"><h4>' + label + '</h4><div class="wp-chips" role="radiogroup" aria-label="' + label + '">' + options.map(function (o) {
                    return '<button type="button" class="wp-chip" role="radio" data-f="' + field + '" data-v="' + o[0] + '">' + esc(o[1]) + '</button>';
                }).join('') + '</div></div>';
            }

            var dlg = el('<div class="wp-backdrop" role="presentation"><div class="wp-dialog wp-editor" role="dialog" aria-modal="true" aria-labelledby="wp-ed-h">' +
                '<h2 id="wp-ed-h">Your avatar</h2>' +
                '<div class="wp-sub">This is who sits in your seat at watch parties.</div>' +
                '<div class="wp-ed-body">' +
                '<div class="wp-ed-stage">' + seatHtml(0) + '<button type="button" class="wp-btn wp-ed-turn">↻ Turn around</button></div>' +
                '<div class="wp-ed-opts">' +
                swatches('Skin', LOOK.skins, 'Skin') +
                chips('HairStyle', LOOK.hairStyles, 'Hair') +
                swatches('HairColor', LOOK.hairColors, 'Hair color') +
                chips('Top', LOOK.tops, 'Top') +
                swatches('TopColor', LOOK.topColors, 'Top color') +
                chips('Accessory', LOOK.accessories, 'Extras') +
                '<label class="wp-ed-photo"><input type="checkbox" class="wp-ed-usephoto"' + (photo ? '' : ' disabled') + '>' +
                (photo ? 'Use my profile picture as my face' : 'Add a profile picture to use it as your face') + '</label>' +
                '</div></div>' +
                '<div class="wp-actions"><button type="button" class="wp-btn wp-ed-random">🎲 Surprise me</button><span style="flex:1"></span>' +
                '<button type="button" class="wp-btn wp-cancel">Cancel</button>' +
                '<button type="button" class="wp-btn wp-btn-primary wp-save">Save</button></div></div></div>');

            var seat = dlg.querySelector('.wp-ed-stage .wp-seat');
            seat.removeAttribute('data-seat');
            seat.classList.remove('wp-empty-seat');
            var label = seat.querySelector('.wp-name');
            label.textContent = name;
            label.style.opacity = '.9';

            function paint() {
                dressLook(seat, look, photo, hue(name) % 99);
                seat.classList.toggle('wp-turn', turned);
                dlg.querySelectorAll('[data-f]').forEach(function (b) {
                    var on = String(look[b.getAttribute('data-f')]) === b.getAttribute('data-v');
                    b.classList.toggle('wp-on', on);
                    b.setAttribute('aria-checked', String(on));
                });
                dlg.querySelector('.wp-ed-usephoto').checked = !!look.UsePhoto;
            }

            var lastFocus = document.activeElement;
            function close() {
                document.removeEventListener('keydown', onKey, true);
                dlg.remove();
                if (lastFocus && lastFocus.focus) lastFocus.focus();
            }
            function onKey(e) { if (isBackKey(e)) { e.preventDefault(); e.stopPropagation(); close(); } }

            dlg.addEventListener('click', function (e) {
                if (e.target === dlg) return close();
                var b = e.target.closest('[data-f]');
                if (b) {
                    look[b.getAttribute('data-f')] = b.getAttribute('data-v');
                    // Show off the change from the side people will see it.
                    turned = b.getAttribute('data-f') !== 'HairStyle' || turned;
                    paint();
                }
            });
            dlg.querySelector('.wp-ed-usephoto').onchange = function () { look.UsePhoto = this.checked; turned = true; paint(); };
            dlg.querySelector('.wp-ed-turn').onclick = function () { turned = !turned; paint(); };
            dlg.querySelector('.wp-ed-random').onclick = function () {
                var r = function (list) { return list[Math.floor(Math.random() * list.length)]; };
                look = {
                    Skin: r(LOOK.skins), HairStyle: r(LOOK.hairStyles)[0], HairColor: r(LOOK.hairColors),
                    Top: r(LOOK.tops)[0], TopColor: r(LOOK.topColors), Accessory: r(LOOK.accessories)[0], UsePhoto: false
                };
                paint();
                emoteSeat(seat, 'cheer');
            };
            dlg.querySelector('.wp-cancel').onclick = close;
            var save = dlg.querySelector('.wp-save');
            save.onclick = function () {
                save.disabled = true;
                call('POST', 'Avatar', look).then(function () {
                    close();
                    toast('Looking good! Your avatar is saved');
                    poll();
                }, function (err) { save.disabled = false; fail(err); });
            };
            document.addEventListener('keydown', onKey, true);
            document.body.appendChild(dlg);
            paint();
            save.focus();
        }).catch(fail);
    }

    // ---------- create / invite dialog ----------

    function openInvite(itemId, itemName, existing) {
        Promise.all([call('GET', 'Friends?itemId=' + encodeURIComponent(itemId)), existing ? Promise.resolve([]) : getDevices()]).then(function (r) {
            var friends = r[0].filter(function (f) { return !f.InParty; });
            var devices = r[1];
            var dlg = el('<div class="wp-backdrop" role="presentation"><div class="wp-dialog" role="dialog" aria-modal="true" aria-labelledby="wp-h">' +
                '<h2 id="wp-h">' + (existing ? 'Invite friends' : 'Start a watch party') + '</h2>' +
                '<div class="wp-sub">' + (existing ? 'They’ll get an invite to join you.' : 'Watch <b>' + esc(itemName) + '</b> together. You control playback; everyone else follows along.') + '</div>' +
                '<div class="wp-list">' + (friends.length ? friends.map(function (f) {
                    return '<label class="wp-opt"><input type="checkbox" class="wp-user" value="' + esc(f.Id) + '"' + (f.Invited ? ' checked disabled' : '') + '>' +
                        avatar(f.Id, f.Name, f.ImageTag, 30) + '<span>' + esc(f.Name) + '</span>' +
                        '<span class="wp-meta"><span class="wp-dot' + (f.Online ? ' wp-dot-on' : '') + '"></span>' + (f.Invited ? 'invited' : f.Online ? 'online' : 'away') + '</span></label>';
                }).join('') : '<div class="wp-empty">Nobody else can watch this. ' + (existing ? '' : 'You can still start a party and invite people later.') + '</div>') + '</div>' +
                (devices.length > 1 ? '<label class="wp-field">Watch on' + deviceSelect(devices) + '</label>' : '') +
                (existing ? '' : '<button type="button" class="wp-linkbtn wp-ed-open">👤 Customize your avatar</button>') +
                '<div class="wp-actions"><button type="button" class="wp-btn wp-cancel">Cancel</button>' +
                '<button type="button" class="wp-btn wp-btn-primary wp-go">' + (existing ? 'Send invites' : 'Start party') + '</button></div></div></div>');

            var lastFocus = document.activeElement;
            function close() {
                document.removeEventListener('keydown', onKey, true);
                dlg.remove();
                if (lastFocus && lastFocus.focus) lastFocus.focus();
            }
            function onKey(e) { if (isBackKey(e)) { e.preventDefault(); e.stopPropagation(); close(); } }
            dlg.addEventListener('click', function (e) { if (e.target === dlg) close(); });
            dlg.querySelector('.wp-cancel').onclick = close;
            var edBtn = dlg.querySelector('.wp-ed-open');
            if (edBtn) edBtn.onclick = openAvatarEditor;
            var go = dlg.querySelector('.wp-go');
            go.onclick = function () {
                var ids = Array.prototype.slice.call(dlg.querySelectorAll('.wp-user:checked:not(:disabled)')).map(function (b) { return b.value; });
                var sel = dlg.querySelector('.wp-device');
                go.disabled = true;
                var req = existing
                    ? call('POST', 'Invite', { UserIds: ids })
                    : call('POST', 'Party', { ItemId: itemId, InviteUserIds: ids, DeviceId: sel ? sel.value : null });
                req.then(function (st) {
                    close();
                    if (st) { S.panelOpen = true; apply(st); } else poll();
                    toast(ids.length ? 'Invited ' + ids.length + (ids.length === 1 ? ' person' : ' people') : existing ? 'No one new invited' : 'Party started');
                }, function (err) { go.disabled = false; fail(err); });
            };
            document.addEventListener('keydown', onKey, true);
            document.body.appendChild(dlg);
            (dlg.querySelector('.wp-user:not(:disabled)') || go).focus();
        }).catch(fail);
    }

    // ---------- details page button ----------

    var itemTypes = {};

    function activeDetailPage() {
        var pages = document.querySelectorAll('#itemDetailPage');
        for (var i = 0; i < pages.length; i++) {
            if (!pages[i].classList.contains('hide')) return pages[i];
        }
        return null;
    }

    function ensureDetailButton() {
        var page = activeDetailPage();
        if (!page || location.hash.indexOf('details') === -1) return;
        var id = hashParam('id');
        var buttons = page.querySelector('.mainDetailButtons');
        if (!id || !buttons) return;

        var btn = buttons.querySelector('.btnWatchParty');
        if (!btn || btn.getAttribute('data-for') !== id) {
            if (btn) btn.remove();
            btn = el('<button is="emby-button" type="button" class="button-flat btnWatchParty detailButton hide" title="Watch party" data-for="' + esc(id) + '">' +
                '<div class="detailButton-content"><span class="detailButton-icon">' + ICON + '</span></div></button>');
            var more = buttons.querySelector('.btnMoreCommands');
            buttons.insertBefore(btn, more || null);
            btn.onclick = function () {
                if (S.party && S.party.ItemId === id) { S.panelOpen = true; render(); return; }
                if (S.party && !confirmSwitch()) return;
                openInvite(id, itemTypes[id] && itemTypes[id].Name, false);
            };
            var known = itemTypes[id];
            var lookup = known ? Promise.resolve(known) : client().getItem(client().getCurrentUserId(), id).then(function (item) {
                itemTypes[id] = { Name: item.Name, ok: item.MediaType === 'Video' && !item.IsFolder };
                return itemTypes[id];
            });
            lookup.then(function (t) {
                if (btn.getAttribute('data-for') === id && t.ok) btn.classList.remove('hide');
            }).catch(function () { btn.remove(); });
        }
        var inThis = !!(S.party && S.party.ItemId === id);
        btn.classList.toggle('wp-active', inThis);
        btn.title = inThis ? 'Open your watch party' : 'Start a watch party';
    }

    var switchAsked = 0;
    function confirmSwitch() {
        // A small in-app confirm rather than window.confirm, which blocks TV webviews.
        if (Date.now() - switchAsked < 6000) return true;
        switchAsked = Date.now();
        toast('You’re already in a party. Press again to leave it and start a new one.');
        return false;
    }

    // ---------- the player: theater, rail and position reports ----------

    function playerContainer() {
        var c = document.querySelector('.videoPlayerContainer');
        if (!c || c.classList.contains('hide') || !c.querySelector('video')) return null;
        return c;
    }

    function onPlayer() { return !!playerContainer(); }

    function osdVisible() {
        var bottom = document.querySelector('.videoOsdBottom');
        if (bottom && !bottom.classList.contains('videoOsdBottom-hidden') && !bottom.classList.contains('hide')) return true;
        return Date.now() - S.pointerAt < 3000;
    }

    function setMode(mode) {
        if (S.mode === mode) return;
        S.mode = mode;
        writePref('wp-mode', mode);
        render();
    }

    function controlsShouldShow(rail) {
        return osdVisible() || (!!rail && rail.contains(document.activeElement)) || !!document.querySelector('.wp-chatbox') || S.panelOpen;
    }

    function renderPlayer() {
        var c = playerContainer();
        var p = S.party;
        var active = !!(c && p && p.OnThisDevice && p.Status !== 'Lobby');
        var rail = document.querySelector('.wp-rail');

        document.querySelectorAll('.wp-scene,.wp-stage-row,.wp-pops,.wp-banner').forEach(function (x) {
            if (!active || x.parentNode !== c) x.remove();
        });
        if (!active) {
            document.querySelectorAll('.videoPlayerContainer.wp-theater').forEach(function (x) { x.classList.remove('wp-theater'); });
            if (rail) rail.remove();
            var vb = document.querySelector('.wp-viewbtn');
            if (vb) vb.remove();
            var cb = document.querySelector('.wp-chatbox');
            if (cb) cb.remove();
            return;
        }

        c.classList.toggle('wp-theater', S.mode === 'theater');
        var scene = c.querySelector(':scope > .wp-scene');
        if (!scene) {
            scene = el('<div class="wp-scene" aria-hidden="true"><div class="wp-valance"></div><div class="wp-curtain wp-curtain-l"></div><div class="wp-curtain wp-curtain-r"></div><div class="wp-glow"></div><div class="wp-floor"></div></div>');
            c.insertBefore(scene, c.firstChild);
        }
        scene.classList.toggle('wp-lights', p.Status === 'Paused');

        var stage = c.querySelector(':scope > .wp-stage-row');
        if (!stage) {
            stage = el('<div class="wp-stage-row" aria-hidden="true">' + rowHtml() + '</div>');
            c.appendChild(stage);
        }
        stage.style.display = S.mode === 'theater' ? '' : 'none';
        fillRow(stage.querySelector('.wp-row'), p.Members);

        if (!c.querySelector(':scope > .wp-pops')) c.appendChild(el('<div class="wp-pops" aria-live="polite"></div>'));

        var banner = c.querySelector(':scope > .wp-banner');
        var host = p.Members.filter(function (m) { return m.IsHost; })[0];
        var bannerText = p.Status === 'Paused' && !p.IsHost && host ? '⏸ ' + host.Name + ' paused the movie' : '';
        if (bannerText && !banner) { banner = el('<div class="wp-banner"></div>'); c.appendChild(banner); }
        if (banner) {
            if (bannerText) setText(banner, bannerText); else banner.remove();
        }

        if (!rail) {
            rail = el('<div class="wp-rail wp-hidden" role="toolbar" aria-label="Watch party">' +
                REACTIONS.map(function (r) {
                    if (r.key === 'pause') return '';
                    return '<button type="button" class="wp-react" data-r="' + r.key + '" title="' + esc(r.label) + '" aria-label="' + esc(r.label) + '">' + r.emoji + '</button>';
                }).join('') + '<hr>' +
                '<button type="button" class="wp-icon-btn wp-ask" data-r="pause" title="Ask the host to pause" aria-label="Ask the host to pause">✋</button>' +
                '<button type="button" class="wp-icon-btn wp-chat-btn" title="Chat" aria-label="Chat">💬</button>' +
                '<button type="button" class="wp-icon-btn wp-mic-btn"></button>' +
                '<button type="button" class="wp-icon-btn wp-mode-btn"></button>' +
                '<button type="button" class="wp-icon-btn wp-party-btn" title="Party" aria-label="Party menu">👥</button></div>');
            rail.addEventListener('click', function (e) {
                if (e.target.closest('[data-r]')) return onReactClick(e);
                if (e.target.closest('.wp-chat-btn')) return openChatbox();
                if (e.target.closest('.wp-mic-btn')) return V.on ? toggleMute() : joinVoice();
                if (e.target.closest('.wp-mode-btn')) return setMode(S.mode === 'theater' ? 'full' : 'theater');
                if (e.target.closest('.wp-party-btn')) { S.panelOpen = !S.panelOpen; render(); }
            });
            // Keep Jellyfin's player shortcuts (space, arrows) from firing while using the rail.
            rail.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
            document.body.appendChild(rail);
        }
        var mode = rail.querySelector('.wp-mode-btn');
        setText(mode, S.mode === 'theater' ? '⛶' : '🎭');
        mode.title = S.mode === 'theater' ? 'Full screen' : 'Theater view';
        mode.setAttribute('aria-label', mode.title);
        rail.querySelector('.wp-ask').style.display = p.IsHost ? 'none' : '';
        var mic = rail.querySelector('.wp-mic-btn');
        mic.style.display = voiceSupported() ? '' : 'none';
        setText(mic, !V.on ? '🎙' : V.muted ? '🔇' : '🎙');
        mic.classList.toggle('wp-mic-live', V.on && !V.muted);
        mic.title = !V.on ? 'Join voice chat' : V.muted ? 'Unmute' : 'Mute';
        mic.setAttribute('aria-label', mic.title);
        // A clearly labelled switch at the top of the player, shown with the player controls.
        var viewBtn = document.querySelector('.wp-viewbtn');
        if (!viewBtn) {
            viewBtn = el('<button type="button" class="wp-viewbtn wp-hidden"></button>');
            viewBtn.onclick = function () { setMode(S.mode === 'theater' ? 'full' : 'theater'); };
            document.body.appendChild(viewBtn);
        }
        setText(viewBtn, S.mode === 'theater' ? '⛶  Full screen movie' : '🎭  Theater view');
        viewBtn.title = (S.mode === 'theater' ? 'Make the movie fill the screen' : 'Back to the theater with everyone’s seats') + ' (T)';

        var show = controlsShouldShow(rail);
        rail.classList.toggle('wp-hidden', !show);
        viewBtn.classList.toggle('wp-hidden', !show);

        hookVideo(c.querySelector('video'));
    }

    function openChatbox() {
        var box = document.querySelector('.wp-chatbox');
        if (box) { box.querySelector('input').focus(); return; }
        box = el('<form class="wp-chatbox"><input type="text" maxlength="140" placeholder="Say something…" aria-label="Chat message">' +
            '<button type="submit" class="wp-btn wp-btn-primary">Send</button></form>');
        var input = box.querySelector('input');
        box.addEventListener('submit', function (e) { onChatSubmit(e); box.remove(); render(); });
        // Typing must not trigger player shortcuts.
        box.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (isBackKey(e)) { e.preventDefault(); box.remove(); render(); }
        });
        box.addEventListener('focusout', function () { setTimeout(function () { if (!box.contains(document.activeElement)) { box.remove(); render(); } }, 150); });
        document.body.appendChild(box);
        input.focus();
    }

    // Full screen mode: the avatar slides in from the corner with the reaction or message.
    function popReaction(m, text, system) {
        var c = playerContainer();
        var pops = c && c.querySelector(':scope > .wp-pops');
        if (!pops || (S.mode === 'theater' && !system)) return;
        var pop = el('<div class="wp-pop"><div class="wp-pop-text"></div></div>');
        pop.querySelector('.wp-pop-text').textContent = text;
        if (m) {
            var seat = el(seatHtml(0));
            seat.removeAttribute('data-seat');
            dressSeat(seat, m);
            seat.classList.add('wp-turn');
            pop.insertBefore(seat, pop.firstChild);
        }
        pops.appendChild(pop);
        while (pops.children.length > 4) pops.firstChild.remove();
        setTimeout(function () { pop.classList.add('wp-pop-out'); }, 3800);
        setTimeout(function () { pop.remove(); }, 4300);
    }

    // The browser tells the server exactly where it is, which keeps everyone tighter than the
    // server's own progress reports (those only arrive every ~10 seconds).
    var reportTimer = null;
    function hookVideo(video) {
        if (!video || video.__wpHooked) return;
        video.__wpHooked = true;
        ['pause', 'play', 'playing', 'seeked'].forEach(function (ev) {
            video.addEventListener(ev, function () {
                clearTimeout(reportTimer);
                reportTimer = setTimeout(report, 250);
            });
        });
    }

    function report() {
        var p = S.party;
        var c = playerContainer();
        var video = c && c.querySelector('video');
        if (!p || !video || !p.OnThisDevice || p.Status === 'Lobby' || isNaN(video.currentTime)) return;
        call('POST', 'Report', { PositionTicks: Math.round(video.currentTime * 1e7), IsPaused: video.paused }).catch(function () { });
    }

    // ---------- wiring ----------

    var scheduled = false;
    function scan() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(function () {
            scheduled = false;
            if (!client()) return;
            render();
        });
    }

    function start() {
        new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        window.addEventListener('hashchange', scan);
        // T switches between the theater and a full screen movie.
        document.addEventListener('keydown', function (e) {
            if ((e.key !== 't' && e.key !== 'T') || e.ctrlKey || e.metaKey || e.altKey) return;
            var t = e.target;
            if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
            if (!document.querySelector('.wp-rail')) return;
            e.preventDefault();
            setMode(S.mode === 'theater' ? 'full' : 'theater');
        });
        document.addEventListener('pointermove', function () {
            if (!onPlayer()) return;
            S.pointerAt = Date.now();
            var rail = document.querySelector('.wp-rail.wp-hidden');
            if (rail) scan();
        }, { passive: true });
        setInterval(function () {
            // Signing out and in as someone else must not show the previous user's party.
            var a = client();
            var u = a ? a.getCurrentUserId() : null;
            if (u !== S.lastUser) {
                S.lastUser = u;
                S.party = null;
                S.partyId = null;
                S.seq = 0;
                S.invites = [];
                S.chat = [];
                S.panelOpen = false;
                devicesCache.at = 0;
                document.querySelectorAll('.wp-pill,.wp-panel,.wp-invites,.wp-rail,.wp-viewbtn').forEach(function (x) { x.remove(); });
                poll();
            }
            if (onPlayer()) {
                if (S.party) report();
                if (V.on) updateDuck();
                var rail = document.querySelector('.wp-rail');
                var show = controlsShouldShow(rail);
                if (rail) rail.classList.toggle('wp-hidden', !show);
                var vb = document.querySelector('.wp-viewbtn');
                if (vb) vb.classList.toggle('wp-hidden', !show);
            }
        }, 2000);
        poll();
        scan();
    }

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
})();
