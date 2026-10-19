// Live-class backend on Supabase. If config.js has no keys, BE.configured is false
// and the classroom runs in Explore and simulated-class modes only.
(function () {
  'use strict';
  const cfg = window.CLASSROOM_CONFIG || {};
  const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && window.supabase.createClient);
  const sb = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const BUCKET = 'lecture-files';

  const BE = {
    configured,
    user: null,          // { id, email, name, role }
    get signedIn() { return !!BE.user; },
    get isLecturer() { return !!BE.user && BE.user.role === 'lecturer'; },
    _authListeners: [],
    onAuth(fn) { BE._authListeners.push(fn); },
  };

  function fail(error, fallback) {
    const e = new Error((error && error.message) || fallback || 'Something went wrong');
    e.code = error && (error.code || error.status);
    throw e;
  }

  async function loadProfile(session) {
    if (!session) { BE.user = null; return; }
    const u = session.user;
    let { data, error } = await sb.from('profiles').select('id, display_name, role').eq('id', u.id).maybeSingle();
    if (error) data = null;
    BE.user = { id: u.id, email: u.email, name: (data && data.display_name) || (u.email || '').split('@')[0] || 'User', role: (data && data.role) || 'student' };
  }

  if (configured) {
    sb.auth.onAuthStateChange((event, session) => {
      // Defer the profile read so it never runs inside the auth callback.
      setTimeout(async () => { await loadProfile(session); BE._authListeners.forEach(fn => fn(BE.user)); }, 0);
    });
  }

  BE.init = async function () {
    if (!configured) return;
    const { data } = await sb.auth.getSession();
    await loadProfile(data && data.session);
  };
  BE.signIn = async function (email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) fail(error, 'Could not sign in');
  };
  BE.signUp = async function (email, password, name) {
    const { data, error } = await sb.auth.signUp({ email, password, options: { data: { display_name: name }, emailRedirectTo: location.href.split('#')[0] } });
    if (error) fail(error, 'Could not create the account');
    return { needsConfirmation: !data.session };
  };
  BE.signOut = async function () { await sb.auth.signOut(); };
  BE.setName = async function (name) {
    const { error } = await sb.from('profiles').update({ display_name: name }).eq('id', BE.user.id);
    if (error) fail(error, 'Could not save your name');
    BE.user.name = name;
  };

  // ---------- Classes ----------
  BE.watchLiveClasses = function (cb) {
    let stopped = false;
    const load = async () => {
      const { data, error } = await sb.from('classes').select('code, course, live, started_at, lecturer_id').eq('live', true).order('started_at', { ascending: false });
      if (!stopped && !error) cb((data || []).map(c => ({ code: c.code, course: c.course, live: c.live, startedAt: Date.parse(c.started_at), lecturerId: c.lecturer_id })));
    };
    load();
    const ch = sb.channel('lobby-classes').on('postgres_changes', { event: '*', schema: 'public', table: 'classes' }, load).subscribe();
    return () => { stopped = true; sb.removeChannel(ch); };
  };
  BE.createClass = async function (code, course) {
    const { error } = await sb.from('classes').insert({ code, course, live: true, lecturer_id: BE.user.id });
    if (error) fail(error, 'Could not start the class');
    const r = await sb.from('class_boards').upsert({ class_code: code, room: 'lecture', kind: 'course', file_paths: [], name: 'Course slides', page: 0, pages: 4 });
    if (r.error) fail(r.error, 'Could not set up the board');
  };
  BE.endClass = async function (code) {
    const { error } = await sb.from('classes').update({ live: false, ended_at: new Date().toISOString() }).eq('code', code);
    if (error) fail(error, 'Could not end the class');
  };
  BE.getClass = async function (code) {
    const { data, error } = await sb.from('classes').select('code, course, live').eq('code', code).maybeSingle();
    if (error) fail(error, 'Could not look up the class');
    return data;
  };
  BE.watchClass = function (code, cb) {
    const ch = sb.channel('class-row-' + code).on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'classes', filter: 'code=eq.' + code }, p => cb(p.new)).subscribe();
    return () => sb.removeChannel(ch);
  };

  // ---------- Boards ----------
  const boardRow = r => r && ({ kind: r.kind, filePaths: r.file_paths || [], name: r.name, page: r.page, pages: r.pages, media: r.media || {} });
  BE.watchBoard = function (code, room, cb) {
    let stopped = false;
    sb.from('class_boards').select('*').eq('class_code', code).eq('room', room).maybeSingle().then(({ data }) => { if (!stopped && data) cb(boardRow(data)); });
    const ch = sb.channel(`board-${code}-${room}`).on('postgres_changes', { event: '*', schema: 'public', table: 'class_boards', filter: 'class_code=eq.' + code }, p => { if (p.new && p.new.room === room) cb(boardRow(p.new)); }).subscribe();
    return () => { stopped = true; sb.removeChannel(ch); };
  };
  BE.setBoard = async function (code, room, b) {
    const row = { class_code: code, room, updated_at: new Date().toISOString() };
    if (b.kind !== undefined) row.kind = b.kind;
    if (b.filePaths !== undefined) row.file_paths = b.filePaths;
    if (b.name !== undefined) row.name = b.name;
    if (b.page !== undefined) row.page = b.page;
    if (b.pages !== undefined) row.pages = b.pages;
    if (b.media !== undefined) row.media = b.media;
    const { error } = await sb.from('class_boards').upsert(row);
    if (error) fail(error, 'Could not update the board');
  };
  BE.uploadFile = async function (code, file, name) {
    const safe = (name || file.name || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
    const path = `${code}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safe}`;
    const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (error) fail(error, 'Upload failed');
    return path;
  };
  BE.fileUrl = async function (path) {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 6);
    if (error) fail(error, 'Could not open the file');
    return data.signedUrl;
  };

  BE.claimLecturer = async function (invite) {
    const { data, error } = await sb.rpc('claim_lecturer', { invite });
    if (error) fail(error, 'Could not check the invite code');
    if (data) { const { data: s } = await sb.auth.getSession(); await loadProfile(s && s.session); BE._authListeners.forEach(fn => fn(BE.user)); }
    return !!data;
  };

  // ---------- Attendance (each student records their own) ----------
  BE.markAttendance = async function (code) {
    if (!BE.user) return;
    await sb.from('attendance').upsert({ class_code: code, student_id: BE.user.id, last_seen: new Date().toISOString() }, { onConflict: 'class_code,student_id' });
  };
  BE.listAttendance = async function (code) {
    const { data, error } = await sb.from('attendance').select('student_id, first_seen, last_seen, profiles(display_name)').eq('class_code', code).order('first_seen');
    if (error) fail(error, 'Could not load attendance');
    return (data || []).map(r => ({ id: r.student_id, name: (r.profiles && r.profiles.display_name) || 'Student', firstSeen: Date.parse(r.first_seen), lastSeen: Date.parse(r.last_seen) }));
  };

  // ---------- Live channel: presence + class events ----------
  BE.joinChannel = function (code, h) {
    const me = BE.user;
    const ch = sb.channel('class:' + code, { config: { presence: { key: me.id }, broadcast: { self: false } } });
    let state = {}, peers = [], subscribed = false, trackTimer = 0, lastTrack = 0;
    const rebuild = () => {
      const st = ch.presenceState(); const now = Date.now(); const list = [];
      for (const key of Object.keys(st)) {
        const metas = st[key]; const m = metas[metas.length - 1] || {};
        list.push(Object.assign({}, m, { key, id: key, me: key === me.id, updatedAt: m.t || now }));
      }
      peers = list; h.onPeers && h.onPeers(peers);
    };
    ch.on('presence', { event: 'sync' }, rebuild)
      .on('presence', { event: 'join' }, ({ key, newPresences }) => { h.onJoin && h.onJoin(key, newPresences && newPresences[newPresences.length - 1]); })
      .on('broadcast', { event: 'gather' }, ({ payload }) => h.onGather && h.onGather(payload))
      .on('broadcast', { event: 'lower' }, ({ payload }) => h.onLower && h.onLower(payload))
      .on('broadcast', { event: 'ended' }, ({ payload }) => h.onEnded && h.onEnded(payload));
    const flush = () => { trackTimer = 0; lastTrack = Date.now(); if (subscribed) ch.track(Object.assign({}, state, { t: lastTrack })).catch(() => {}); };
    ch.subscribe(status => {
      if (status === 'SUBSCRIBED') { subscribed = true; flush(); h.onStatus && h.onStatus(true); }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') { h.onStatus && h.onStatus(false, status); }
    });
    return {
      presence(patch) {
        Object.assign(state, patch);
        const wait = 300 - (Date.now() - lastTrack);
        if (wait <= 0 && !trackTimer) flush();
        else if (!trackTimer) trackTimer = setTimeout(flush, Math.max(wait, 0));
        return Promise.resolve();
      },
      emit(event, payload) {
        if (!subscribed) return Promise.reject(new Error('not connected'));
        return ch.send({ type: 'broadcast', event, payload: Object.assign({ from: me.id }, payload || {}) });
      },
      peers() { return peers; },
      leave() { clearTimeout(trackTimer); try { ch.untrack(); } catch (e) {} return sb.removeChannel(ch); },
    };
  };

  window.BE = BE;
})();
