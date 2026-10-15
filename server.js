// BRAVEN · Controle de estoque
// Servidor sem dependências: Node puro + arquivo JSON em DATA_DIR.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PUBLIC = path.join(__dirname, "public");
const SESSION_DAYS = 30;

/* ---------------- banco (arquivo JSON) ---------------- */
const uid = () => crypto.randomBytes(6).toString("hex");

function hashPass(pass, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(pass, salt, 64).toString("hex") };
}
function checkPass(user, pass) {
  const h = crypto.scryptSync(pass, user.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(user.hash, "hex"));
}

// produtos iniciais: o catálogo do site, com estoque zerado
const V_MASC = ["Masculina G", "Masculina GG", "Masculina G1"];
const V_BABY = ["Babylook M", "Babylook G", "Babylook GG"];
const SEED = [
  ["Coleção Valores", "FORÇA.", "Verde estonado", [...V_MASC, ...V_BABY]],
  ["Coleção Valores", "FÉ.", "Azul estonado", [...V_MASC, ...V_BABY]],
  ["Coleção Valores", "PROPÓSITO.", "Vermelho estonado", [...V_MASC, ...V_BABY]],
  ["Coleção Valores", "CORAGEM.", "Terracota estonado", [...V_MASC, ...V_BABY]],
  ["Seja Forte & Corajoso", "SEJA FORTE & CORAJOSO", "Preta", ["Masculina G", "Masculina GG", "Feminina M", "Feminina G"]],
  ["Seja Forte & Corajoso", "SEJA FORTE & CORAJOSO", "Verde militar", ["Masculina G", "Masculina GG"]],
  ["Croppeds", "Cropped FORÇA.", "Verde estonado", ["M", "G"]],
  ["Croppeds", "Cropped FÉ.", "Azul estonado", ["M", "G"]],
  ["Croppeds", "Cropped PROPÓSITO.", "Vermelho estonado", ["M", "G"]],
  ["Croppeds", "Cropped CORAGEM.", "Terracota estonado", ["M", "G"]],
  ["Infantil", "CORAGEM. Infantil", "Verde", ["6 anos", "8 anos"]],
  ["Bonés", "BONÉ ÁGUIA", "Preto", ["Único"]],
  ["Bonés", "BONÉ ÁGUIA", "Verde e marrom", ["Único"]],
];

let db;
function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return;
  }
  const user = (process.env.ADMIN_USER || "lili").toLowerCase();
  let pass = process.env.ADMIN_PASS;
  if (!pass) {
    pass = crypto.randomBytes(5).toString("hex");
    console.log(`\n  Primeiro acesso → usuário: ${user}  senha: ${pass}\n  (troque a senha dentro do sistema)\n`);
  }
  db = {
    users: [{ user, nome: user.charAt(0).toUpperCase() + user.slice(1), ...hashPass(pass) }],
    sessions: {},
    products: SEED.map(([grupo, nome, cor, vars]) => ({
      id: uid(), grupo, nome, cor, min: 2,
      variantes: vars.map(v => ({ id: uid(), nome: v, qtd: 0 })),
    })),
    moves: [],
  };
  save();
}
function save() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------------- sessão ---------------- */
function getSession(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || "");
  const s = m && db.sessions[m[1]];
  if (!s || s.exp < Date.now()) return null;
  const user = db.users.find(u => u.user === s.user);
  return user ? { sid: m[1], user } : null;
}
function cookie(res, sid, maxAge) {
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

// trava simples contra chute de senha: 8 erros por IP a cada 15 min
const fails = new Map();
function tooMany(ip) {
  const f = fails.get(ip);
  if (!f || f.until < Date.now()) return false;
  return f.n >= 8;
}
function addFail(ip) {
  const f = fails.get(ip);
  if (!f || f.until < Date.now()) fails.set(ip, { n: 1, until: Date.now() + 15 * 60e3 });
  else f.n++;
}

/* ---------------- helpers ---------------- */
function send(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
const fail = (res, msg, code = 400) => send(res, code, { erro: msg });
function body(req) {
  return new Promise((ok, no) => {
    let s = "";
    req.on("data", c => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(new Error("JSON inválido")); } });
  });
}
const txt = (v, max = 80) => String(v ?? "").trim().slice(0, max);
const int = v => (Number.isInteger(Number(v)) ? Number(v) : NaN);
function findVariant(id) {
  for (const p of db.products) {
    const v = p.variantes.find(x => x.id === id);
    if (v) return { p, v };
  }
  return null;
}
function publicState() {
  return { products: db.products, moves: db.moves.slice(-300).reverse() };
}

/* ---------------- rotas da API ---------------- */
async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  // o proxy (Traefik) acrescenta o IP real no fim; o começo da lista pode ser forjado pelo cliente
  const ip = req.headers["x-forwarded-for"]?.split(",").pop().trim() || req.socket.remoteAddress;

  if (route === "POST /api/login") {
    if (tooMany(ip)) return fail(res, "Muitas tentativas. Espere 15 minutos.", 429);
    const { user, pass } = await body(req);
    const u = db.users.find(x => x.user === txt(user).toLowerCase());
    if (!u || !checkPass(u, String(pass || ""))) { addFail(ip); return fail(res, "Usuário ou senha incorretos.", 401); }
    fails.delete(ip);
    const sid = crypto.randomBytes(24).toString("hex");
    db.sessions[sid] = { user: u.user, exp: Date.now() + SESSION_DAYS * 864e5 };
    for (const [k, s] of Object.entries(db.sessions)) if (s.exp < Date.now()) delete db.sessions[k];
    save();
    cookie(res, sid, SESSION_DAYS * 86400);
    return send(res, 200, { nome: u.nome });
  }

  const s = getSession(req);
  if (!s) return fail(res, "Faça login.", 401);
  const me = s.user;

  if (route === "POST /api/logout") {
    delete db.sessions[s.sid]; save();
    cookie(res, "", 0);
    return send(res, 200, { ok: true });
  }
  if (route === "GET /api/state") return send(res, 200, { me: { user: me.user, nome: me.nome }, ...publicState() });

  // venda (baixa), entrada ou ajuste de contagem
  if (route === "POST /api/move") {
    const b = await body(req);
    const f = findVariant(b.variantId);
    if (!f) return fail(res, "Produto não encontrado.");
    const n = int(b.qtd);
    let delta;
    if (b.tipo === "venda") {
      if (!(n > 0)) return fail(res, "Quantidade inválida.");
      if (n > f.v.qtd) return fail(res, `Só tem ${f.v.qtd} em estoque.`);
      delta = -n;
    } else if (b.tipo === "entrada") {
      if (!(n > 0)) return fail(res, "Quantidade inválida.");
      delta = n;
    } else if (b.tipo === "ajuste") {
      if (!(n >= 0)) return fail(res, "Quantidade inválida.");
      delta = n - f.v.qtd;
      if (delta === 0) return send(res, 200, publicState());
    } else return fail(res, "Tipo inválido.");
    f.v.qtd += delta;
    db.moves.push({
      id: uid(), ts: Date.now(), por: me.nome, tipo: b.tipo, delta, saldo: f.v.qtd,
      variantId: f.v.id, produto: `${f.p.nome} · ${f.p.cor}`, variante: f.v.nome, obs: txt(b.obs, 120),
    });
    save();
    return send(res, 200, publicState());
  }

  // desfazer um lançamento
  let m;
  if (req.method === "POST" && (m = url.pathname.match(/^\/api\/moves\/(\w+)\/desfazer$/))) {
    const mv = db.moves.find(x => x.id === m[1]);
    if (!mv || mv.desfeito) return fail(res, "Lançamento não encontrado.");
    const f = findVariant(mv.variantId);
    if (f) {
      if (f.v.qtd - mv.delta < 0) return fail(res, "Não dá para desfazer: o estoque ficaria negativo.");
      f.v.qtd -= mv.delta;
    }
    mv.desfeito = { por: me.nome, ts: Date.now() };
    save();
    return send(res, 200, publicState());
  }

  // cadastro de produtos
  if (route === "POST /api/products") {
    const b = await body(req);
    const nome = txt(b.nome), vars = (b.variantes || []).map(v => txt(v, 40)).filter(Boolean);
    if (!nome) return fail(res, "Dê um nome ao produto.");
    if (!vars.length) vars.push("Único");
    db.products.push({
      id: uid(), grupo: txt(b.grupo) || "Outros", nome, cor: txt(b.cor), min: Math.max(0, int(b.min) || 0),
      variantes: vars.map(v => ({ id: uid(), nome: v, qtd: 0 })),
    });
    save();
    return send(res, 200, publicState());
  }
  if (req.method === "PUT" && (m = url.pathname.match(/^\/api\/products\/(\w+)$/))) {
    const p = db.products.find(x => x.id === m[1]);
    if (!p) return fail(res, "Produto não encontrado.");
    const b = await body(req);
    if (!txt(b.nome)) return fail(res, "Dê um nome ao produto.");
    p.nome = txt(b.nome); p.cor = txt(b.cor); p.grupo = txt(b.grupo) || "Outros";
    p.min = Math.max(0, int(b.min) || 0);
    // variantes: mantém as que vieram com id, cria as novas, remove as que sumiram (só se zeradas)
    const next = [];
    for (const v of b.variantes || []) {
      const nomeV = txt(v.nome, 40);
      if (!nomeV) continue;
      const old = v.id && p.variantes.find(x => x.id === v.id);
      if (old) { old.nome = nomeV; next.push(old); } else next.push({ id: uid(), nome: nomeV, qtd: 0 });
    }
    const removed = p.variantes.filter(v => !next.includes(v));
    const blocked = removed.find(v => v.qtd > 0);
    if (blocked) return fail(res, `"${blocked.nome}" ainda tem ${blocked.qtd} em estoque. Zere antes de remover.`);
    if (!next.length) return fail(res, "O produto precisa de pelo menos um tamanho.");
    p.variantes = next;
    save();
    return send(res, 200, publicState());
  }
  if (req.method === "DELETE" && (m = url.pathname.match(/^\/api\/products\/(\w+)$/))) {
    const i = db.products.findIndex(x => x.id === m[1]);
    if (i < 0) return fail(res, "Produto não encontrado.");
    db.products.splice(i, 1);
    save();
    return send(res, 200, publicState());
  }

  // conta
  if (route === "POST /api/senha") {
    const b = await body(req);
    if (!checkPass(me, String(b.atual || ""))) return fail(res, "Senha atual incorreta.");
    if (String(b.nova || "").length < 6) return fail(res, "A nova senha precisa de pelo menos 6 caracteres.");
    Object.assign(me, hashPass(String(b.nova)));
    for (const [k, x] of Object.entries(db.sessions)) if (x.user === me.user && k !== s.sid) delete db.sessions[k];
    save();
    return send(res, 200, { ok: true });
  }
  if (route === "GET /api/usuarios") return send(res, 200, db.users.map(u => ({ user: u.user, nome: u.nome })));
  if (route === "POST /api/usuarios") {
    const b = await body(req);
    const user = txt(b.user, 30).toLowerCase();
    if (!/^[a-z0-9._-]{2,30}$/.test(user)) return fail(res, "Usuário: só letras minúsculas, números, ponto ou traço.");
    if (db.users.some(u => u.user === user)) return fail(res, "Esse usuário já existe.");
    if (String(b.senha || "").length < 6) return fail(res, "A senha precisa de pelo menos 6 caracteres.");
    db.users.push({ user, nome: txt(b.nome, 40) || user, ...hashPass(String(b.senha)) });
    save();
    return send(res, 200, db.users.map(u => ({ user: u.user, nome: u.nome })));
  }
  if (req.method === "DELETE" && (m = url.pathname.match(/^\/api\/usuarios\/([\w.-]+)$/))) {
    if (m[1] === me.user) return fail(res, "Você não pode remover a si mesma.");
    db.users = db.users.filter(u => u.user !== m[1]);
    for (const [k, x] of Object.entries(db.sessions)) if (x.user === m[1]) delete db.sessions[k];
    save();
    return send(res, 200, db.users.map(u => ({ user: u.user, nome: u.nome })));
  }

  // planilha (CSV para abrir no Excel)
  if (route === "GET /api/estoque.csv") {
    const q = v => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [["Grupo", "Produto", "Cor", "Tamanho", "Quantidade", "Mínimo"]];
    db.products.forEach(p => p.variantes.forEach(v => rows.push([p.grupo, p.nome, p.cor, v.nome, v.qtd, p.min])));
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="estoque-braven-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    return res.end("﻿" + rows.map(r => r.map(q).join(";")).join("\r\n"));
  }

  fail(res, "Rota não encontrada.", 404);
}

/* ---------------- arquivos estáticos ---------------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
function staticFile(res, pathname) {
  const file = path.join(PUBLIC, pathname === "/" ? "index.html" : pathname);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end("Não encontrado");
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

load();
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else staticFile(res, decodeURIComponent(url.pathname));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) fail(res, "Erro interno.", 500);
  }
}).listen(PORT, () => console.log(`Estoque BRAVEN rodando em http://localhost:${PORT}`));
