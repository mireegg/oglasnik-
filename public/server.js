require('dotenv').config();
const fetch2 = require('node-fetch');
const axios = require('axios');
const bcrypt = require('bcrypt');
const SALT_ROUNDS = 10;
const express = require('express');
const nodemailer = require('nodemailer');
const https = require('https');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function getModelProsjekHelper(pool, naslov, fallback) {
    // Izvuci brend i model iz naslova
    const rijeci = (naslov || '').split(' ').filter(r => r.length > 1);
    if (rijeci.length < 2) return fallback;

    const brend = rijeci[0];
    const model = rijeci[1];
    const MIN_UZORAKA = 4;

    // Pokusaj dohvatiti godiste, gorivo, transmisiju, km iz live_oglasi
    // Kriteriji od najpreciznijeg do najsirim

    const kriteriji = [
        // 1. Brend + model + godiste +-2 + gorivo + transmisija
        { where: `naslov ILIKE $1 AND naslov ILIKE $2 AND godiste BETWEEN $3 AND $4 AND gorivo = $5 AND transmisija = $6`,
          buildParams: (d) => d.godiste && d.gorivo && d.transmisija ?
            ['%'+brend+'%', '%'+model+'%', d.godiste-2, d.godiste+2, d.gorivo, d.transmisija] : null },
        // 2. Brend + model + godiste +-2 + gorivo
        { where: `naslov ILIKE $1 AND naslov ILIKE $2 AND godiste BETWEEN $3 AND $4 AND gorivo = $5`,
          buildParams: (d) => d.godiste && d.gorivo ?
            ['%'+brend+'%', '%'+model+'%', d.godiste-2, d.godiste+2, d.gorivo] : null },
        // 3. Brend + model + godiste +-2
        { where: `naslov ILIKE $1 AND naslov ILIKE $2 AND godiste BETWEEN $3 AND $4`,
          buildParams: (d) => d.godiste ?
            ['%'+brend+'%', '%'+model+'%', d.godiste-2, d.godiste+2] : null },
        // 4. Brend + model
        { where: `naslov ILIKE $1 AND naslov ILIKE $2`,
          buildParams: () => ['%'+brend+'%', '%'+model+'%'] },
        // 5. Brend + cjenovni rang +-40%
        { where: `naslov ILIKE $1 AND cijena_num BETWEEN $2 AND $3`,
          buildParams: (d) => d.cijenaNum ?
            ['%'+brend+'%', d.cijenaNum * 0.6, d.cijenaNum * 1.4] : null },
        // 6. Samo cjenovni rang kao zadnji fallback
        { where: `cijena_num BETWEEN $1 AND $2`,
          buildParams: (d) => d.cijenaNum ?
            [d.cijenaNum * 0.7, d.cijenaNum * 1.3] : null },
    ];

    for (const kriterij of kriteriji) {
        const params = kriterij.buildParams(this || {});
        if (!params) continue;
        try {
            const res = await pool.query(
                `SELECT AVG(cijena_num) as avg, COUNT(*) as broj, 
                        MIN(cijena_num) as min, MAX(cijena_num) as max
                 FROM live_oglasi
                 WHERE cijena_num > 1000 AND cijena_num < 999999
                 AND ${kriterij.where}`,
                params
            );
            const avg = parseFloat(res.rows[0]?.avg);
            const broj = parseInt(res.rows[0]?.broj) || 0;
            if (avg && broj >= MIN_UZORAKA) {
                return { avg, broj, min: parseFloat(res.rows[0].min), max: parseFloat(res.rows[0].max) };
            }
        } catch(e) { continue; }
    }
    return { avg: fallback, broj: 0, min: 0, max: 0 };
}

async function getModelProsjekZaOglas(pool, o, fallback) {
    // Izvuci dostupne podatke iz konkurent_oglasi reda
    const naslov = o.naslov || '';
    const rijeci = naslov.split(' ').filter(r => r.length > 1);
    if (rijeci.length < 2) return { avg: fallback, broj: 0 };

    const brend = rijeci[0];
    const model = rijeci[1];
    const cijenaNum = parseFloat(o.cijena_num) || 0;
    const MIN_UZORAKA = 4;

    // Pokuasaj sve kombinacije od najpreciznijeg
    const queries = [];

    // Godiste iz naslova (ako postoji)
    const godMatch = naslov.match(/\b(19[89]\d|20[0-2]\d)\b/);
    const godiste = godMatch ? parseInt(godMatch[1]) : null;

    // Gorivo iz naslova
    let gorivo = null;
    if (/tdi|cdi|dci|hdi|dizel|diesel/i.test(naslov)) gorivo = 'Dizel';
    else if (/tsi|fsi|benzin|bensin/i.test(naslov)) gorivo = 'Benzin';
    else if (/hibrid|hybrid/i.test(naslov)) gorivo = 'Hibrid';

    // Transmisija iz naslova
    let transmisija = null;
    if (/dsg|automat|tiptronic|automatic|s\s?tronic/i.test(naslov)) transmisija = 'Automatski';
    else if (/manuelni|manual|manuell/i.test(naslov)) transmisija = 'Manuelni';

    // Kriteriji od najpreciznijeg
    const kriteriji = [];

    if (godiste && gorivo && transmisija) {
        kriteriji.push({
            sql: `naslov ILIKE $1 AND naslov ILIKE $2 AND godiste BETWEEN $3 AND $4 AND gorivo = $5 AND transmisija = $6`,
            params: ['%'+brend+'%', '%'+model+'%', godiste-2, godiste+2, gorivo, transmisija]
        });
    }
    if (godiste && gorivo) {
        kriteriji.push({
            sql: `naslov ILIKE $1 AND naslov ILIKE $2 AND godiste BETWEEN $3 AND $4 AND gorivo = $5`,
            params: ['%'+brend+'%', '%'+model+'%', godiste-2, godiste+2, gorivo]
        });
    }
    if (godiste) {
        kriteriji.push({
            sql: `naslov ILIKE $1 AND naslov ILIKE $2 AND godiste BETWEEN $3 AND $4`,
            params: ['%'+brend+'%', '%'+model+'%', godiste-2, godiste+2]
        });
    }
    kriteriji.push({
        sql: `naslov ILIKE $1 AND naslov ILIKE $2`,
        params: ['%'+brend+'%', '%'+model+'%']
    });
    if (cijenaNum > 0) {
        kriteriji.push({
            sql: `naslov ILIKE $1 AND cijena_num BETWEEN $2 AND $3`,
            params: ['%'+brend+'%', cijenaNum * 0.6, cijenaNum * 1.4]
        });
        kriteriji.push({
            sql: `cijena_num BETWEEN $1 AND $2`,
            params: [cijenaNum * 0.7, cijenaNum * 1.3]
        });
    }

    for (const k of kriteriji) {
        try {
            const res = await pool.query(
                `SELECT AVG(cijena_num) as avg, COUNT(*) as broj,
                        MIN(cijena_num) as min_c, MAX(cijena_num) as max_c
                 FROM live_oglasi
                 WHERE cijena_num > 1000 AND cijena_num < 999999
                 AND ${k.sql}`,
                k.params
            );
            const avg = parseFloat(res.rows[0]?.avg);
            const broj = parseInt(res.rows[0]?.broj) || 0;
            if (avg && broj >= MIN_UZORAKA) {
                return {
                    avg, broj,
                    min: parseFloat(res.rows[0].min_c),
                    max: parseFloat(res.rows[0].max_c),
                    gorivo, transmisija, godiste
                };
            }
        } catch(e) { continue; }
    }
    return { avg: fallback, broj: 0 };
}


async function initDB() {
    await pool.query(`CREATE TABLE IF NOT EXISTS korisnici (id SERIAL PRIMARY KEY, ime VARCHAR(100), email VARCHAR(100) UNIQUE, lozinka VARCHAR(100), datum TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS prijave (id SERIAL PRIMARY KEY, ime VARCHAR(100), email VARCHAR(100), telefon VARCHAR(50), datum TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pracenja (id SERIAL PRIMARY KEY, korisnik_email VARCHAR(100), pretraga VARCHAR(200), aktivno BOOLEAN DEFAULT true, datum TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS live_oglasi (id SERIAL PRIMARY KEY, naslov TEXT, cijena TEXT, slika TEXT, link TEXT UNIQUE, platforma VARCHAR(50) DEFAULT 'olx', kategorija VARCHAR(100), datum TIMESTAMP DEFAULT NOW())`);
    await pool.query(`ALTER TABLE pracenja ADD COLUMN IF NOT EXISTS link TEXT`);
    await pool.query(`ALTER TABLE pracenja ADD COLUMN IF NOT EXISTS slika TEXT`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS kategorija VARCHAR(100)`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS brand_id INTEGER`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS available BOOLEAN DEFAULT true`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS datum_nestanka TIMESTAMP`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS dana_do_prodaje INTEGER`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS cijena_num NUMERIC`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS godiste INTEGER`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS boja VARCHAR(50)`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS gorivo VARCHAR(50)`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS km INTEGER`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS grad VARCHAR(100)`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS kw INTEGER`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_live_oglasi_kategorija ON live_oglasi(kategorija)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_live_oglasi_available ON live_oglasi(available)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_live_oglasi_datum ON live_oglasi(datum)`);
    await pool.query(`ALTER TABLE korisnici ADD COLUMN IF NOT EXISTS plan VARCHAR(50) DEFAULT 'free'`);
    await pool.query(`ALTER TABLE korisnici ADD COLUMN IF NOT EXISTS plan_datum_isteka TIMESTAMP`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS cijena_stara NUMERIC`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS datum_pada_cijene TIMESTAMP`);
    console.log('Baza inicijalizovana!');
}
initDB();

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

// ── AUTH ─────────────────────────────────────────────────
app.post('/prijava', async (req, res) => {
    const { ime, email, telefon } = req.body;
    await pool.query('INSERT INTO prijave (ime, email, telefon) VALUES ($1, $2, $3)', [ime, email, telefon]);
    transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject: 'Dobro dosli na Oglix!', html: `<h2>Zdravo ${ime}!</h2>` }).catch(() => {});
    res.json({ uspjeh: true });
});

app.post('/register', async (req, res) => {
    const { ime, email, lozinka } = req.body;
    if (!ime || !email || !lozinka) return res.json({ uspjeh: false, poruka: 'Sva polja su obavezna!' });
    if (lozinka.length < 6) return res.json({ uspjeh: false, poruka: 'Lozinka mora imati min. 6 karaktera!' });
    try {
        const hash = await bcrypt.hash(lozinka, SALT_ROUNDS);
        const result = await pool.query('INSERT INTO korisnici (ime, email, lozinka) VALUES ($1, $2, $3) RETURNING ime, email', [ime, email, hash]);
        transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject: 'Dobro došli na Oglix!', html: `<h2>Zdravo ${ime}!</h2><p>Vaš account je kreiran.</p>` }).catch(() => {});
        res.json({ uspjeh: true, korisnik: result.rows[0] });
    } catch (e) {
        res.json({ uspjeh: false, poruka: e.code === '23505' ? 'Email je već registrovan!' : 'Greška pri registraciji.' });
    }
});

app.post('/login', async (req, res) => {
    const { email, lozinka } = req.body;
    if (!email || !lozinka) return res.json({ uspjeh: false, poruka: 'Unesite email i lozinku!' });
    try {
        const result = await pool.query('SELECT * FROM korisnici WHERE email = $1', [email]);
        if (!result.rows.length) return res.json({ uspjeh: false, poruka: 'Pogrešan email ili lozinka!' });
        const ok = await bcrypt.compare(lozinka, result.rows[0].lozinka);
        if (ok) res.json({ uspjeh: true, korisnik: { ime: result.rows[0].ime, email: result.rows[0].email } });
        else res.json({ uspjeh: false, poruka: 'Pogrešan email ili lozinka!' });
    } catch (e) { res.json({ uspjeh: false, poruka: 'Greška pri prijavi.' }); }
});

// ── PRAĆENJA ─────────────────────────────────────────────
app.post('/pracenje', async (req, res) => {
    const { email, pretraga, link, slika } = req.body;
    await pool.query('INSERT INTO pracenja (korisnik_email, pretraga, link, slika) VALUES ($1, $2, $3, $4)', [email, pretraga, link || null, slika || null]);
    res.json({ uspjeh: true });
});
app.delete('/pracenje/:id', async (req, res) => {
    await pool.query('DELETE FROM pracenja WHERE id = $1', [req.params.id]);
    res.json({ uspjeh: true });
});
app.get('/moja-pracenja', async (req, res) => {
    const result = await pool.query('SELECT * FROM pracenja WHERE korisnik_email = $1 AND aktivno = true ORDER BY datum DESC', [req.query.email]);
    res.json(result.rows);
});

// ── AI ANALIZA LISTE ──────────────────────────────────────
app.post('/ai-analiza', async (req, res) => {
    const { oglasi, pretraga } = req.body;
    const prompt = `Ti si iskusan savjetnik za kupovinu u Bosni i Hercegovini.
Kupac traži: "${pretraga}"
Oglasi:
${oglasi.map((o, i) => `${i+1}. ${o.naslov} — ${o.cijenaStr}`).join('\n')}
Za svaki oglas daj kratku OCJENU i AI SCORE (0-100). Na kraju ZAKLJUCAK koji je najisplativiji.
Odgovaraj na bosanskom. Budi konkretan.`;
    try {
        const analiza = await claudeAI(prompt, 1500);
        res.json({ uspjeh: true, analiza });
    } catch(e) {
        res.json({ uspjeh: false, poruka: 'Greška pri analizi' });
    }
});

// ── HELPER FUNKCIJE ───────────────────────────────────────
function parseCijena(str) {
    if (!str) return 0;
    return parseFloat(str.toString().replace(/\./g,'').replace(',','.').replace(/[^0-9.]/g,'')) || 0;
}

async function dohvatiOlxDetalje(id) {
    const det = await axios.get(`https://olx.ba/api/listings/${id}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
        timeout: 8000
    });
    const attrs = {};
    (det.data.attributes || []).forEach(a => { attrs[a.attr_code] = a.value; });
    return { data: det.data, attrs, images: det.data.images || [] };
}

async function claudeAI(prompt, maxTokens = 500) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: prompt }]
        })
    });
    const data = await response.json();
    return data.content?.[0]?.text || null;
}

// Alias za kompatibilnost
const groqAI = claudeAI;

// ── OLX DETALJI OGLASA ────────────────────────────────────
app.get('/api/oglas-detalji/:id', async (req, res) => {
    try {
        const { data, attrs } = await dohvatiOlxDetalje(req.params.id);
        const categoryId = data.category_id;
        let kategorija_tip = 'ostalo';
        if ([31, 1495, 2076, 252].includes(categoryId)) kategorija_tip = 'mobiteli';
        else if ([38, 39].includes(categoryId)) kategorija_tip = 'racunari';
        else if ([23, 24, 25, 29].includes(categoryId)) kategorija_tip = 'nekretnine';
        else if (categoryId === 18) kategorija_tip = 'vozila';
        res.json({
            uspjeh: true,
            detalji: {
                id: data.id, naslov: data.title,
                category_id: categoryId, kategorija_tip,
                brand: data.brand?.name || '',
                model: data.model?.name || '',
                brand_id: data.brand?.id || null,
                model_id: data.model?.id || null,
                grad: data.cities?.[0]?.name || 'BiH',
                slike: data.images || [],
                godiste: attrs['godiste'] || null,
                gorivo: attrs['gorivo'] || null,
                transmisija: attrs['transmisija'] || null,
                km: attrs['kilometra-a'] || null,
                kubikaza: attrs['kubikaza'] || null,
                kw: attrs['kilovata-kw'] || null,
                boja: attrs['boja'] || null,
                tip_vozila: attrs['tip'] || null,
                pogon: attrs['pogon'] || null,
                os: attrs['os-operativni-sistem'] || null,
                interna_memorija: attrs['interna-memorija'] || null,
                ram_mob: attrs['ram'] || null,
                procesor: attrs['procesor'] || null,
                ram_pc: attrs['ram'] || null,
                ssd: attrs['ssd-kapacitet-gb'] || null,
                graficka: attrs['grafi-ka-karta'] || null,
                os_pc: attrs['operativni-sistem'] || null,
                broj_soba: attrs['broj-soba'] || null,
                kvadrata: attrs['kvadrata'] || null,
                sprat: attrs['sprat'] || null,
                namjesten: attrs['namjesten'] || null,
                grijanje: attrs['vrsta-grijanja'] || null,
                vrsta_nekretnine: attrs['vrsta-nekretnine'] || null,
            }
        });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});

// ── AUTOBUM DETALJI OGLASA ────────────────────────────────
app.get('/api/autobum-detalji/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const response = await fetch2(`https://api.autobum.ba/api/v1/articles/${id}`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://autobum.ba/' }
        });
        const data = await response.json();
        const o = data.data || data;
        const attrs = {};
        if (o.attributes) o.attributes.forEach(a => { attrs[a.name] = a.value; });
        if (o.fields) o.fields.forEach(f => { attrs[f.name] = f.value; });
        const naslovLower = (o.title || '').toLowerCase();
        const brendovi = {
            'volkswagen':89,'vw':89,'audi':7,'bmw':11,'mercedes':56,
            'opel':47,'peugeot':65,'renault':71,'toyota':72,'honda':30,
            'ford':20,'skoda':77,'škoda':77,'seat':57,'fiat':29,
            'citroen':9,'citroën':9,'hyundai':35,'kia':39,'mazda':46,
            'nissan':41,'suzuki':66,'volvo':90,'porsche':69,'jeep':22,
            'mitsubishi':64,'subaru':62,'dacia':15,'alfa romeo':2,'mini':36
        };
        let detectedBrandId = null;
        for (const [naziv, bid] of Object.entries(brendovi)) {
            if (naslovLower.includes(naziv)) { detectedBrandId = bid; break; }
        }
        res.json({
            uspjeh: true,
            detalji: {
                id: o.id, naslov: o.title, kategorija_tip: 'vozila',
                brand: o.brand?.name || o.make || '',
                model: o.model?.name || o.model_name || '',
                brand_id: detectedBrandId, model_id: null,
                grad: o.city?.name || (o.location && o.location.city) || 'BiH',
                slike: o.images || (o.image ? [o.image] : []),
                godiste: attrs['Godina'] || attrs['year'] || o.year || null,
                gorivo: attrs['Gorivo'] || attrs['fuel_type'] || o.fuel || o.fuel_type || null,
                transmisija: attrs['Mjenjač'] || attrs['transmission'] || o.transmission || null,
                km: attrs['Kilometraža'] || attrs['mileage'] || o.mileage || null,
                kubikaza: attrs['Zapremina motora'] || attrs['engine_displacement'] || o.engine_displacement || null,
                kw: attrs['Snaga motora'] || attrs['engine_power'] || o.power_kw || o.engine_power || null,
                boja: attrs['Boja'] || attrs['color'] || o.color || null,
                tip_vozila: attrs['Tip vozila'] || o.body_type || null,
                pogon: attrs['Pogon'] || o.drive_type || null,
            }
        });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});

// ── SLIČNI OGLASI PO NAZIVU ───────────────────────────────
app.post('/api/slicni-po-nazivu', async (req, res) => {
    try {
        const { naslov, cijena, brand_id, gorivo, godiste, km } = req.body;
        if (!naslov && !brand_id) return res.json({ uspjeh: false, grupa1: [], grupa2: [] });
        const cijenaNum = parseCijena(cijena);
        const cijenaOd = cijenaNum > 0 ? Math.round(cijenaNum * 0.55) : 0;
        const cijenaDo = cijenaNum > 0 ? Math.round(cijenaNum * 1.55) : 999999;
        let searchUrl = `https://olx.ba/api/search?category_id=18&per_page=40`;
        if (brand_id) searchUrl += `&brand=${brand_id}&brands=${brand_id}`;
        if (cijenaOd > 0) searchUrl += `&price_from=${cijenaOd}&price_to=${cijenaDo}`;
        const searchRes = await axios.get(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
            timeout: 12000
        });
        const sviOglasi = searchRes.data.data || [];
        const mapirani = sviOglasi.map(o => {
            const labels = {};
            (o.special_labels || []).forEach(l => { labels[l.label] = l.value; });
            return {
                id: o.id, naslov: o.title,
                cijena: o.display_price || 'Na upit',
                cijena_num: parseCijena(o.display_price),
                slika: o.image || '',
                link: `https://www.olx.ba/artikal/${o.id}`,
                platforma: 'olx',
                godiste: labels['Godište'] ? parseInt(labels['Godište']) : null,
                gorivo: labels['Gorivo'] || null,
                km: labels['Kilometraža'] ? parseInt(String(labels['Kilometraža']).replace(/[^0-9]/g,'')) : null,
            };
        });
        const godNum = parseInt(godiste) || 0;
        let grupa1 = mapirani.filter(o => {
            if (gorivo && o.gorivo && o.gorivo.toLowerCase() !== gorivo.toLowerCase()) return false;
            if (godNum && o.godiste && Math.abs(o.godiste - godNum) > 2) return false;
            return true;
        }).slice(0, 6);
        if (grupa1.length < 2) grupa1 = mapirani.slice(0, 6);
        const g1ids = new Set(grupa1.map(o => o.id));
        const grupa2 = mapirani.filter(o => !g1ids.has(o.id)).slice(0, 4);
        let aiAnaliza = null;
        if (grupa1.length > 0) {
            const aiPrompt = `Ti si direktan savjetnik za kupovinu vozila u BiH.
OGLAS: ${naslov} — ${cijena}
Godište: ${godiste||'—'} | Gorivo: ${gorivo||'—'} | KM: ${km ? parseInt(km).toLocaleString()+' km' : '—'}
SLIČNI OLX OGLASI:
${grupa1.map((o,i) => {
    const c = parseCijena(o.cijena);
    const odnos = c && cijenaNum ? (c < cijenaNum ? ` (−${Math.round((cijenaNum-c)/cijenaNum*100)}% jeftiniji)` : c > cijenaNum ? ` (+${Math.round((c-cijenaNum)/cijenaNum*100)}% skuplji)` : ' (ista cijena)') : '';
    return `#${i+1}: ${o.naslov} — ${o.cijena}${odnos} | KM: ${o.km||'—'} | God: ${o.godiste||'—'}`;
}).join('\n')}
ZAKLJUČAK: [prosječna cijena, usporedba]
PREPORUKA: [jedna rečenica]
Bosanski.`;
            aiAnaliza = await groqAI(aiPrompt, 400);
        }
        res.json({ uspjeh: true, grupa1, grupa2, preciznost: 'Isti brend, slična cijena', aiAnaliza });
    } catch(e) {
        res.json({ uspjeh: false, grupa1: [], grupa2: [], poruka: e.message });
    }
});

// ── LIVE OGLASI ───────────────────────────────────────────
app.post('/api/sacuvaj-oglase', async (req, res) => {
    const { oglasi } = req.body;
    if (!oglasi || !oglasi.length) return res.json({ uspjeh: false });
    try {
        for (const o of oglasi) {
            const existing = await pool.query('SELECT cijena_num FROM live_oglasi WHERE link = $1', [o.link]);
            const novaCijenaNum = parseCijena(o.cijena);
            if (existing.rows.length > 0) {
                const staraCijenaNum = parseFloat(existing.rows[0].cijena_num) || 0;
                const pala = staraCijenaNum > 0 && novaCijenaNum > 0 && novaCijenaNum < staraCijenaNum - 50;
                await pool.query(
                    `UPDATE live_oglasi SET cijena = $1, slika = $2, kategorija = $3, cijena_num = $4
                     ${pala ? ', cijena_stara = $5, datum_pada_cijene = NOW()' : ''}
                     WHERE link = $${pala ? 6 : 5}`,
                    pala
                        ? [o.cijena, o.slika, o.kategorija || null, novaCijenaNum, staraCijenaNum, o.link]
                        : [o.cijena, o.slika, o.kategorija || null, novaCijenaNum, o.link]
                );
            } else {
                await pool.query(
                    `INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija, cijena_num) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (link) DO NOTHING`,
                    [o.naslov, o.cijena, o.slika, o.link, o.platforma, o.kategorija || null, novaCijenaNum || null]
                );
            }
        }
        provjeriAlerte(oglasi).catch(() => {});
        res.json({ uspjeh: true, sacuvano: oglasi.length });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});

app.get('/api/live-oglasi', async (req, res) => {
    try {
        const { q, kategorija, platforma, sort } = req.query;
        const offset = parseInt(req.query.offset) || 0;
        const limit = parseInt(req.query.limit) || 48;
        let uvjeti = [], params = [], i = 1;
        if (q) { uvjeti.push(`naslov ILIKE $${i++}`); params.push(`%${q}%`); }
        if (kategorija) {
            const kats = kategorija.split(',').map(k => k.trim());
            uvjeti.push(`kategorija IN (${kats.map(() => `$${i++}`).join(',')})`);
            params.push(...kats);
        }
        if (req.query.kategorija_like) {
            uvjeti.push(`kategorija LIKE $${i++}`);
            params.push(req.query.kategorija_like + '%');
        }
        if (platforma) {
            const plats = platforma.split(',').map(p => p.trim());
            uvjeti.push(`platforma IN (${plats.map(() => `$${i++}`).join(',')})`);
            params.push(...plats);
        }
        if (req.query.cijena_od) { uvjeti.push(`cijena_num >= $${i++}`); params.push(parseFloat(req.query.cijena_od)); }
        if (req.query.cijena_do) { uvjeti.push(`cijena_num <= $${i++}`); params.push(parseFloat(req.query.cijena_do)); }
        if (req.query.gorivo) {
            uvjeti.push(`(gorivo ILIKE $${i} OR naslov ILIKE $${i+1})`);
            params.push(`%${req.query.gorivo}%`, `%${req.query.gorivo}%`);
            i += 2;
        }
        if (req.query.transmisija) {
            uvjeti.push(`naslov ILIKE $${i++}`);
            params.push(`%${req.query.transmisija}%`);
        }
        if (req.query.godiste_od && req.query.godiste_do) {
            uvjeti.push(`(godiste BETWEEN $${i} AND $${i+1} OR (godiste IS NULL AND naslov ~ '[0-9]{4}' AND CAST(SUBSTRING(naslov FROM '[0-9]{4}') AS INTEGER) BETWEEN $${i} AND $${i+1}))`);
            params.push(parseInt(req.query.godiste_od), parseInt(req.query.godiste_do));
            i += 2;
        } else if (req.query.godiste_od) {
            uvjeti.push(`(godiste >= $${i} OR (godiste IS NULL AND naslov ~ '[0-9]{4}' AND CAST(SUBSTRING(naslov FROM '[0-9]{4}') AS INTEGER) >= $${i}))`);
            params.push(parseInt(req.query.godiste_od));
            i += 1;
        } else if (req.query.godiste_do) {
            uvjeti.push(`(godiste <= $${i} OR (godiste IS NULL AND naslov ~ '[0-9]{4}' AND CAST(SUBSTRING(naslov FROM '[0-9]{4}') AS INTEGER) <= $${i}))`);
            params.push(parseInt(req.query.godiste_do));
            i += 1;
        }
        if (req.query.km_od) { uvjeti.push(`km >= $${i++}`); params.push(parseInt(req.query.km_od)); }
        if (req.query.km_do) { uvjeti.push(`km <= $${i++}`); params.push(parseInt(req.query.km_do)); }
        if (req.query.kw_od) { uvjeti.push(`kw >= $${i++}`); params.push(parseInt(req.query.kw_od)); }
        if (req.query.kw_do) { uvjeti.push(`kw <= $${i++}`); params.push(parseInt(req.query.kw_do)); }
        const where = uvjeti.length ? 'WHERE ' + uvjeti.join(' AND ') : '';
        let orderBy = 'datum DESC';
        if (sort === 'cijena_asc') orderBy = 'cijena_num ASC NULLS LAST';
        if (sort === 'cijena_desc') orderBy = 'cijena_num DESC NULLS LAST';
        const countResult = await pool.query(`SELECT COUNT(*) FROM live_oglasi ${where}`, params);
        const ukupno = parseInt(countResult.rows[0].count);
        params.push(limit, offset);
        const result = await pool.query(
            `SELECT *, (datum_pada_cijene > NOW() - INTERVAL '7 days') as cijena_pala FROM live_oglasi ${where} ORDER BY ${orderBy} LIMIT $${i++} OFFSET $${i++}`,
            params
        );
        res.json({ uspjeh: true, oglasi: result.rows, ukupno, offset, limit });
    } catch(e) { res.json({ uspjeh: false, oglasi: [] }); }
});

app.get('/api/kategorije', async (req, res) => {
    try {
        const result = await pool.query(`SELECT kategorija, COUNT(*) as broj FROM live_oglasi WHERE kategorija IS NOT NULL GROUP BY kategorija ORDER BY broj DESC`);
        res.json({ uspjeh: true, kategorije: result.rows });
    } catch(e) { res.json({ uspjeh: false, kategorije: [] }); }
});

// ── AI ANALIZA JEDNOG OGLASA ──────────────────────────────
// ── AI ANALIZA JEDNOG ────────────────────────────────────
app.post('/api/analiza-jednog-oglasa', async (req, res) => {
    const { oglas } = req.body;
    const d = oglas.detalji || {};
    const katTip = d.kategorija_tip || 'ostalo';
    const cijenaNum = parseCijena(oglas.cijenaStr);

    // Dohvati tržišni prosjek iz baze
    let trzisniKontekst = '';
    if (katTip === 'vozila' && cijenaNum > 0) {
        const modelInfo = await getModelProsjekZaOglas(pool, {
            naslov: oglas.naslov,
            cijena_num: cijenaNum,
            godiste: d.godiste ? parseInt(d.godiste) : null,
            gorivo: d.gorivo || null,
            transmisija: d.transmisija || null
        }, 0);

        if (modelInfo.avg > 0 && modelInfo.broj >= 3) {
            const razlika = Math.round(cijenaNum - modelInfo.avg);
            const posto = Math.round((razlika / modelInfo.avg) * 100);
            const smjer = razlika > 0 ? `+${posto}% IZNAD` : `${posto}% ISPOD`;
            trzisniKontekst = `
TRŽIŠNI KONTEKST (iz baze ${modelInfo.broj} sličnih oglasa u BiH):
- Prosječna cijena sličnih vozila: ${Math.round(modelInfo.avg).toLocaleString()} KM
- Raspon: ${Math.round(modelInfo.min).toLocaleString()} — ${Math.round(modelInfo.max).toLocaleString()} KM
- Ovaj oglas je ${smjer} tržišnog prosjeka (${Math.abs(razlika).toLocaleString()} KM razlike)
${d.gorivo ? '- Gorivo filtrirano: ' + d.gorivo : ''}
${d.godiste ? '- Godište filtrirano: ' + d.godiste + ' ±2' : ''}
${d.transmisija ? '- Transmisija: ' + d.transmisija : ''}`;
        }
    } else if (katTip === 'nekretnine' && d.kvadrata && cijenaNum > 0) {
        const m2 = Math.round(cijenaNum / parseFloat(d.kvadrata));
        const avg = await pool.query(
            `SELECT AVG(cijena_num/kvadrata::numeric) as avg_m2, COUNT(*) as broj
             FROM live_oglasi WHERE kategorija LIKE 'nekretnine%'
             AND cijena_num > 10000 AND kvadrata IS NOT NULL AND kvadrata::numeric > 0`,
        );
        if (avg.rows[0]?.avg_m2) {
            const avgM2 = Math.round(parseFloat(avg.rows[0].avg_m2));
            const posto = Math.round(((m2 - avgM2) / avgM2) * 100);
            trzisniKontekst = `
TRŽIŠNI KONTEKST:
- Cijena ovog oglasa: ${m2.toLocaleString()} KM/m²
- Prosjek tržišta: ${avgM2.toLocaleString()} KM/m² (uzorak: ${avg.rows[0].broj} oglasa)
- Ovaj oglas je ${posto > 0 ? '+'+posto+'% IZNAD' : posto+'% ISPOD'} prosjeka`;
        }
    } else if ((katTip === 'mobiteli' || katTip === 'racunari') && cijenaNum > 0) {
        const kat = katTip === 'mobiteli' ? 'elektronika-mobiteli' : 'elektronika-laptopi';
        const avg = await pool.query(
            `SELECT AVG(cijena_num) as avg, COUNT(*) as broj FROM live_oglasi
             WHERE kategorija = $1 AND cijena_num > 0 AND naslov ILIKE $2`,
            [kat, '%' + (oglas.naslov || '').split(' ').slice(0,2).join('%') + '%']
        );
        if (avg.rows[0]?.avg && avg.rows[0].broj >= 3) {
            const avgVal = Math.round(parseFloat(avg.rows[0].avg));
            const posto = Math.round(((cijenaNum - avgVal) / avgVal) * 100);
            trzisniKontekst = `
TRŽIŠNI KONTEKST (${avg.rows[0].broj} sličnih oglasa u BiH):
- Prosječna cijena sličnih: ${avgVal.toLocaleString()} KM
- Ovaj oglas je ${posto > 0 ? '+'+posto+'% IZNAD' : posto+'% ISPOD'} prosjeka`;
        }
    }

    let prompt = '';
    if (katTip === 'vozila') {
        prompt = `Ti si vrhunski savjetnik za kupovinu vozila u Bosni i Hercegovini sa 20 godina iskustva. Poznaješ tržišne vrijednosti, tipične probleme modela i sve zamke pri kupovini.

OGLAS:
Vozilo: ${oglas.naslov}
Cijena: ${oglas.cijenaStr}
Godište: ${d.godiste||'—'} | Gorivo: ${d.gorivo||'—'} | Kilometraža: ${d.km ? Number(d.km).toLocaleString()+' km' : '—'}
Kubikaža: ${d.kubikaza||'—'} | Snaga: ${d.kw ? d.kw+' kW ('+Math.round(d.kw*1.36)+' KS)' : '—'}
Transmisija: ${d.transmisija||'—'} | Boja: ${d.boja||'—'} | Grad: ${d.grad||'—'}
${trzisniKontekst}

Daj preciznu analizu u OVOM FORMATU:

OCJENA: [ODLIČNO/FER/PREVISOKO/IZBJEGAVAJ]
CIJENA: [Je li cijena fer u odnosu na tržišni prosjek? Konkretan komentar sa brojevima.]
PREGOVARANJE: [Za koliko KM možeš pregovarati? Budi konkretan — npr. "Ponudi 12.500 KM"]
SAVJET: [Šta obavezno provjeriti fizički na ovom vozilu? Koji su tipični problemi ovog modela i godišta?]
SCORE: [0-100]

Budi direktan i konkretan. Koristi tržišne podatke iz konteksta. Bosanski jezik.`;

    } else if (katTip === 'mobiteli') {
        prompt = `Ti si expert za tržište mobitela u BiH.

OGLAS: ${oglas.naslov} — ${oglas.cijenaStr}
OS: ${d.os||'—'} | Memorija: ${d.interna_memorija||'—'} | RAM: ${d.ram_mob||'—'}
${trzisniKontekst}

OCJENA: [ODLIČNO/FER/PREVISOKO/IZBJEGAVAJ]
CIJENA: [Komentar sa poređenjem sa novom cijenom i tržišnim prosjekom]
PREGOVARANJE: [Konkretna cifra za pregovaranje]
SAVJET: [Šta fizički provjeriti — baterija, ekran, Face ID/fingerprint, oštećenja, originalna kutija]
SCORE: [0-100]

Bosanski. Direktno.`;

    } else if (katTip === 'racunari') {
        prompt = `Ti si expert za tržište računara u BiH.

OGLAS: ${oglas.naslov} — ${oglas.cijenaStr}
CPU: ${d.procesor||'—'} | RAM: ${d.ram_pc||'—'} | SSD: ${d.ssd ? d.ssd+'GB' : '—'} | GPU: ${d.graficka||'—'}
${trzisniKontekst}

OCJENA: [ODLIČNO/FER/PREVISOKO/IZBJEGAVAJ]
CIJENA: [Vrijednost komponenti vs cijena]
PREGOVARANJE: [Konkretna cifra]
SAVJET: [Šta testirati — stres test GPU/CPU, disk health, baterija ako laptop, napajanje]
SCORE: [0-100]

Bosanski. Direktno.`;

    } else if (katTip === 'nekretnine') {
        prompt = `Ti si iskusan agent za nekretnine u BiH.

OGLAS: ${oglas.naslov} — ${oglas.cijenaStr}
Površina: ${d.kvadrata||'—'}m² | Sobe: ${d.broj_soba||'—'} | Sprat: ${d.sprat||'—'}
Namješteno: ${d.namjesten||'—'} | Grijanje: ${d.grijanje||'—'}
${trzisniKontekst}

OCJENA: [ODLIČNO/FER/PREVISOKO/IZBJEGAVAJ]
CIJENA: [Cijena/m² analiza, usporedba sa tržištem]
PREGOVARANJE: [Konkretna cifra za pregovaranje]
SAVJET: [Obavezno provjeriti: uknjižba/ZK, instalacije struja/voda/grijanje, vlaga, etažiranje, komunalije]
SCORE: [0-100]

Bosanski. Direktno.`;

    } else {
        prompt = `Ti si savjetnik za kupovinu u BiH.
Oglas: ${oglas.naslov} — ${oglas.cijenaStr}
${trzisniKontekst}
OCJENA: [ODLIČNO/FER/PREVISOKO/IZBJEGAVAJ]
CIJENA: [komentar]
PREGOVARANJE: [konkretna cifra]
SAVJET: [preporuka]
SCORE: [0-100]
Bosanski.`;
    }

    try {
        const tekst = await claudeAI(prompt, 600);
        const scoreMatch = (tekst||'').match(/SCORE:\s*(\d+)/);
        res.json({ uspjeh: true, analiza: tekst || 'Analiza nije dostupna.', score: scoreMatch ? parseInt(scoreMatch[1]) : 70 });
    } catch(e) {
        res.json({ uspjeh: false, analiza: 'Analiza nije dostupna.', score: 70 });
    }
});
app.get('/api/slicni-oglasi', async (req, res) => res.json({ uspjeh: true, oglasi: [] }));

// ── SLIČNI OGLASI — SVE KATEGORIJE ────────────────────────
app.post('/api/slicni-dvije-grupe', async (req, res) => {
    try {
        const d = req.body;
        const kategorija_tip = d.kategorija_tip || 'ostalo';
        const olx_id = d.olx_id;
        const cijenaNum = parseCijena(d.cijena);
        let grupa1 = [], grupa2 = [], preciznost = '', aiAnaliza = null;

        if (kategorija_tip === 'vozila') {
            if (!d.brand_id || !d.model_id) return res.json({ uspjeh: false, grupa1: [], grupa2: [], poruka: 'Nema brand/model za vozilo' });
            const cijenaOd = cijenaNum > 0 ? Math.round(cijenaNum * 0.55) : 0;
            const cijenaDo = cijenaNum > 0 ? Math.round(cijenaNum * 1.55) : 999999;
            let searchUrl = `https://olx.ba/api/search?category_id=18&per_page=40&brand=${d.brand_id}&brands=${d.brand_id}&models=${d.model_id}`;
            if (cijenaOd > 0) searchUrl += `&price_from=${cijenaOd}&price_to=${cijenaDo}`;
            const searchRes = await axios.get(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' }, timeout: 12000 });
            const kandidati = (searchRes.data.data || []).filter(o => String(o.id) !== String(olx_id));
            const detaljPromises = kandidati.slice(0, 20).map(async (o) => {
                try {
                    const { attrs, images } = await dohvatiOlxDetalje(o.id);
                    return {
                        id: o.id, naslov: o.title,
                        cijena: o.display_price || 'Na upit',
                        cijena_num: parseCijena(o.display_price),
                        slika: o.image || images[0] || '',
                        link: `https://www.olx.ba/artikal/${o.id}`,
                        platforma: 'olx',
                        godiste: attrs['godiste'] ? parseInt(attrs['godiste']) : null,
                        gorivo: attrs['gorivo'] || null,
                        transmisija: attrs['transmisija'] || null,
                        km: attrs['kilometra-a'] ? parseInt(attrs['kilometra-a']) : null,
                        kubikaza: attrs['kubikaza'] ? parseFloat(attrs['kubikaza']) : null,
                        kw: attrs['kilovata-kw'] ? parseInt(attrs['kilovata-kw']) : null,
                        boja: attrs['boja'] || null,
                    };
                } catch(e) { return null; }
            });
            const svi = (await Promise.all(detaljPromises)).filter(Boolean);
            const godNum = parseInt(d.godiste) || 0;
            const kubNum = parseFloat(d.kubikaza) || 0;
            const kwNum = parseInt(d.kw) || 0;
            grupa1 = svi.filter(o => {
                if (d.gorivo && o.gorivo && o.gorivo.toLowerCase() !== d.gorivo.toLowerCase()) return false;
                if (kubNum && o.kubikaza !== null && Math.abs(o.kubikaza - kubNum) > 0.1) return false;
                if (kwNum && o.kw !== null && Math.abs(o.kw - kwNum) > 5) return false;
                if (godNum && o.godiste !== null && Math.abs(o.godiste - godNum) > 1) return false;
                if (d.boja && o.boja && o.boja.toLowerCase() !== d.boja.toLowerCase()) return false;
                return true;
            });
            if (grupa1.length >= 2) preciznost = 'Isti motor, godište i boja';
            if (grupa1.length < 2) {
                grupa1 = svi.filter(o => {
                    if (d.gorivo && o.gorivo && o.gorivo.toLowerCase() !== d.gorivo.toLowerCase()) return false;
                    if (kubNum && o.kubikaza !== null && Math.abs(o.kubikaza - kubNum) > 0.1) return false;
                    if (kwNum && o.kw !== null && Math.abs(o.kw - kwNum) > 5) return false;
                    if (godNum && o.godiste !== null && Math.abs(o.godiste - godNum) > 1) return false;
                    return true;
                });
                if (grupa1.length >= 2) preciznost = 'Isti motor i godište';
            }
            if (grupa1.length < 2) {
                grupa1 = svi.filter(o => {
                    if (d.gorivo && o.gorivo && o.gorivo.toLowerCase() !== d.gorivo.toLowerCase()) return false;
                    if (kubNum && o.kubikaza !== null && Math.abs(o.kubikaza - kubNum) > 0.1) return false;
                    if (godNum && o.godiste !== null && Math.abs(o.godiste - godNum) > 2) return false;
                    return true;
                });
                if (grupa1.length >= 2) preciznost = 'Isti motor, godište ±2';
            }
            if (grupa1.length < 2) {
                grupa1 = svi.filter(o => {
                    if (d.gorivo && o.gorivo && o.gorivo.toLowerCase() !== d.gorivo.toLowerCase()) return false;
                    if (godNum && o.godiste !== null && Math.abs(o.godiste - godNum) > 3) return false;
                    return true;
                });
                preciznost = 'Isti model i gorivo';
            }
            grupa1 = grupa1.sort((a,b) => (a.km||999999)-(b.km||999999)).slice(0, 6);
            const g1ids = new Set(grupa1.map(o=>o.id));
            grupa2 = svi.filter(o => !g1ids.has(o.id) && (!d.gorivo || !o.gorivo || o.gorivo.toLowerCase()===d.gorivo.toLowerCase())).sort((a,b) => (a.km||999999)-(b.km||999999)).slice(0, 4);
            if (grupa1.length > 0) {
                const aiPrompt = `Ti si direktan savjetnik za kupovinu vozila u BiH.
OGLAS: ${d.cijena} | God: ${d.godiste||'—'} | Gorivo: ${d.gorivo||'—'} | KM: ${d.km ? parseInt(d.km).toLocaleString()+' km' : '—'} | Motor: ${d.kubikaza ? d.kubikaza+'L' : '—'} ${d.kw ? d.kw+'kW' : '—'}
IDENTIČNI OGLASI (${preciznost}):
${grupa1.map((o,i) => {
    const c = parseCijena(o.cijena);
    const odnos = c && cijenaNum ? (c < cijenaNum ? ` (−${Math.round((cijenaNum-c)/cijenaNum*100)}%)` : c > cijenaNum ? ` (+${Math.round((c-cijenaNum)/cijenaNum*100)}%)` : '') : '';
    return `#${i+1}: ${o.naslov} — ${o.cijena}${odnos} | KM: ${o.km||'—'} | God: ${o.godiste||'—'}`;
}).join('\n')}
ZAKLJUČAK: [prosječna cijena, usporedba sa tržištem]
PREPORUKA: [jedna direktna rečenica]
UPOZORENJE: [samo ako postoji razlog]
Bosanski. Direktno.`;
                aiAnaliza = await groqAI(aiPrompt, 400);
            }
        } else if (kategorija_tip === 'mobiteli') {
            if (!d.brand_id && !d.model_id) return res.json({ uspjeh: false, grupa1: [], grupa2: [], poruka: 'Nema brand/model za mobitel' });
            const cijenaOd = cijenaNum > 0 ? Math.round(cijenaNum * 0.60) : 0;
            const cijenaDo = cijenaNum > 0 ? Math.round(cijenaNum * 1.50) : 999999;
            let searchUrl = `https://olx.ba/api/search?category_id=31&per_page=40`;
            if (d.brand_id) searchUrl += `&brand=${d.brand_id}&brands=${d.brand_id}`;
            if (d.model_id) searchUrl += `&models=${d.model_id}`;
            if (cijenaOd > 0) searchUrl += `&price_from=${cijenaOd}&price_to=${cijenaDo}`;
            const searchRes = await axios.get(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' }, timeout: 12000 });
            const kandidati = (searchRes.data.data || []).filter(o => String(o.id) !== String(olx_id));
            const detaljPromises = kandidati.slice(0, 20).map(async (o) => {
                try {
                    const { attrs, images } = await dohvatiOlxDetalje(o.id);
                    return { id: o.id, naslov: o.title, cijena: o.display_price || 'Na upit', cijena_num: parseCijena(o.display_price), slika: o.image || images[0] || '', link: `https://www.olx.ba/artikal/${o.id}`, platforma: 'olx', os: attrs['os-operativni-sistem'] || null, interna_memorija: attrs['interna-memorija'] || null, ram: attrs['ram'] || null };
                } catch(e) { return null; }
            });
            const svi = (await Promise.all(detaljPromises)).filter(Boolean);
            if (d.model_id && d.interna_memorija) {
                grupa1 = svi.filter(o => o.interna_memorija === d.interna_memorija);
                if (grupa1.length >= 2) preciznost = 'Isti model i memorija';
            }
            if (grupa1.length < 2) { grupa1 = svi; preciznost = 'Isti model'; }
            grupa1 = grupa1.sort((a,b) => (a.cijena_num||999999)-(b.cijena_num||999999)).slice(0, 6);
            const g1ids = new Set(grupa1.map(o=>o.id));
            grupa2 = svi.filter(o => !g1ids.has(o.id)).slice(0, 4);
            if (grupa1.length > 0) {
                const aiPrompt = `Ti si savjetnik za kupovinu mobitela u BiH.
MOBITEL: ${d.brand} ${d.model} — ${d.cijena} | OS: ${d.os||'—'} | Memorija: ${d.interna_memorija||'—'}
IDENTIČNI OGLASI (${preciznost}):
${grupa1.map((o,i) => {
    const c = parseCijena(o.cijena);
    const odnos = c && cijenaNum ? (c < cijenaNum ? ` (−${Math.round((cijenaNum-c)/cijenaNum*100)}%)` : c > cijenaNum ? ` (+${Math.round((c-cijenaNum)/cijenaNum*100)}%)` : '') : '';
    return `#${i+1}: ${o.naslov} — ${o.cijena}${odnos} | Mem: ${o.interna_memorija||'—'}`;
}).join('\n')}
ZAKLJUČAK: [prosječna cijena, je li fer?]
PREPORUKA: [kupi oglas #X ili pregovaraj]
UPOZORENJE: [šta fizički provjeriti — baterija, ekran, oštećenja]
Bosanski.`;
                aiAnaliza = await groqAI(aiPrompt, 400);
            }
        } else if (kategorija_tip === 'racunari') {
            const categoryId = d.category_id || 38;
            const cijenaOd = cijenaNum > 0 ? Math.round(cijenaNum * 0.55) : 0;
            const cijenaDo = cijenaNum > 0 ? Math.round(cijenaNum * 1.55) : 999999;
            let searchUrl = `https://olx.ba/api/search?category_id=${categoryId}&per_page=40`;
            if (d.brand_id) searchUrl += `&brand=${d.brand_id}&brands=${d.brand_id}`;
            if (cijenaOd > 0) searchUrl += `&price_from=${cijenaOd}&price_to=${cijenaDo}`;
            const searchRes = await axios.get(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' }, timeout: 12000 });
            const kandidati = (searchRes.data.data || []).filter(o => String(o.id) !== String(olx_id));
            const detaljPromises = kandidati.slice(0, 20).map(async (o) => {
                try {
                    const { attrs, images } = await dohvatiOlxDetalje(o.id);
                    return { id: o.id, naslov: o.title, cijena: o.display_price || 'Na upit', cijena_num: parseCijena(o.display_price), slika: o.image || images[0] || '', link: `https://www.olx.ba/artikal/${o.id}`, platforma: 'olx', procesor: attrs['procesor'] || null, ram: attrs['ram'] || null, ssd: attrs['ssd-kapacitet-gb'] || null, graficka: attrs['grafi-ka-karta'] || null };
                } catch(e) { return null; }
            });
            const svi = (await Promise.all(detaljPromises)).filter(Boolean);
            if (d.procesor && d.ram_pc && d.graficka) {
                grupa1 = svi.filter(o => o.procesor === d.procesor && o.ram === d.ram_pc && o.graficka === d.graficka);
                if (grupa1.length >= 2) preciznost = 'Isti procesor, RAM i grafička';
            }
            if (grupa1.length < 2 && d.procesor && d.ram_pc) {
                grupa1 = svi.filter(o => o.procesor === d.procesor && o.ram === d.ram_pc);
                if (grupa1.length >= 2) preciznost = 'Isti procesor i RAM';
            }
            if (grupa1.length < 2 && d.procesor) {
                grupa1 = svi.filter(o => o.procesor === d.procesor);
                if (grupa1.length >= 2) preciznost = 'Isti procesor';
            }
            if (grupa1.length < 2) { grupa1 = svi; preciznost = 'Slična kategorija i cijena'; }
            grupa1 = grupa1.sort((a,b) => (a.cijena_num||999999)-(b.cijena_num||999999)).slice(0, 6);
            const g1ids = new Set(grupa1.map(o=>o.id));
            grupa2 = svi.filter(o => !g1ids.has(o.id)).slice(0, 4);
            if (grupa1.length > 0) {
                const aiPrompt = `Ti si savjetnik za kupovinu računara u BiH.
RAČUNAR: ${d.naslov||'—'} — ${d.cijena} | CPU: ${d.procesor||'—'} | RAM: ${d.ram_pc||'—'} | GPU: ${d.graficka||'—'}
SLIČNI (${preciznost}):
${grupa1.map((o,i) => {
    const c = parseCijena(o.cijena);
    const odnos = c && cijenaNum ? (c < cijenaNum ? ` (−${Math.round((cijenaNum-c)/cijenaNum*100)}%)` : c > cijenaNum ? ` (+${Math.round((c-cijenaNum)/cijenaNum*100)}%)` : '') : '';
    return `#${i+1}: ${o.naslov} — ${o.cijena}${odnos} | CPU: ${o.procesor||'—'} | RAM: ${o.ram||'—'} | GPU: ${o.graficka||'—'}`;
}).join('\n')}
ZAKLJUČAK: [vrijednost komponenti, usporedba]
PREPORUKA: [direktna preporuka]
UPOZORENJE: [šta provjeriti — GPU stabilnost, SSD, napajanje]
Bosanski.`;
                aiAnaliza = await groqAI(aiPrompt, 400);
            }
        } else if (kategorija_tip === 'nekretnine') {
            const categoryId = d.category_id || 23;
            const cijenaOd = cijenaNum > 0 ? Math.round(cijenaNum * 0.65) : 0;
            const cijenaDo = cijenaNum > 0 ? Math.round(cijenaNum * 1.40) : 999999;
            const kvadrati = parseFloat(d.kvadrata) || 0;
            let searchUrl = `https://olx.ba/api/search?category_id=${categoryId}&per_page=40`;
            if (cijenaOd > 0) searchUrl += `&price_from=${cijenaOd}&price_to=${cijenaDo}`;
            const searchRes = await axios.get(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' }, timeout: 12000 });
            const kandidati = (searchRes.data.data || []).filter(o => String(o.id) !== String(olx_id));
            const detaljPromises = kandidati.slice(0, 20).map(async (o) => {
                try {
                    const { data: oData, attrs, images } = await dohvatiOlxDetalje(o.id);
                    const kv = parseFloat(attrs['kvadrata']) || 0;
                    return { id: o.id, naslov: o.title, cijena: o.display_price || 'Na upit', cijena_num: parseCijena(o.display_price), slika: o.image || images[0] || '', link: `https://www.olx.ba/artikal/${o.id}`, platforma: 'olx', kvadrata: kv || null, broj_soba: attrs['broj-soba'] || null, sprat: attrs['sprat'] || null, namjesten: attrs['namjesten'] || null, grad: oData.cities?.[0]?.name || null, cijena_m2: kv > 0 && parseCijena(o.display_price) > 0 ? Math.round(parseCijena(o.display_price) / kv) : null };
                } catch(e) { return null; }
            });
            const svi = (await Promise.all(detaljPromises)).filter(Boolean);
            const cijenaM2Trenutni = kvadrati > 0 && cijenaNum > 0 ? Math.round(cijenaNum / kvadrati) : 0;
            if (d.broj_soba) {
                grupa1 = svi.filter(o => {
                    if (o.broj_soba !== d.broj_soba) return false;
                    if (kvadrati && o.kvadrata && Math.abs(o.kvadrata - kvadrati) > 15) return false;
                    return true;
                });
                if (grupa1.length >= 2) preciznost = `Isti tip (${d.broj_soba}), slična kvadratura`;
            }
            if (grupa1.length < 2 && d.broj_soba) {
                grupa1 = svi.filter(o => o.broj_soba === d.broj_soba);
                if (grupa1.length >= 2) preciznost = `Isti tip stana (${d.broj_soba})`;
            }
            if (grupa1.length < 2 && kvadrati) {
                grupa1 = svi.filter(o => o.kvadrata && Math.abs(o.kvadrata - kvadrati) <= 20);
                preciznost = `Slična kvadratura (${kvadrati}m² ±20)`;
            }
            if (grupa1.length < 2) { grupa1 = svi; preciznost = 'Slična cijena, isti tip'; }
            grupa1 = grupa1.sort((a,b) => (a.cijena_m2||999999)-(b.cijena_m2||999999)).slice(0, 6);
            const g1ids = new Set(grupa1.map(o=>o.id));
            grupa2 = svi.filter(o => !g1ids.has(o.id)).slice(0, 4);
            if (grupa1.length > 0) {
                const aiPrompt = `Ti si agent za nekretnine u BiH.
NEKRETNINA: ${d.naslov||'—'} — ${d.cijena} ${cijenaM2Trenutni > 0 ? '('+cijenaM2Trenutni+' KM/m²)' : ''} | ${d.kvadrata||'—'}m² | ${d.broj_soba||'—'} sobe | Grad: ${d.grad||'—'}
SLIČNE (${preciznost}):
${grupa1.map((o,i) => {
    const c = parseCijena(o.cijena);
    const odnos = c && cijenaNum ? (c < cijenaNum ? ` (−${Math.round((cijenaNum-c)/cijenaNum*100)}%)` : c > cijenaNum ? ` (+${Math.round((c-cijenaNum)/cijenaNum*100)}%)` : '') : '';
    return `#${i+1}: ${o.naslov} — ${o.cijena}${odnos} ${o.cijena_m2 ? '| '+o.cijena_m2+' KM/m²' : ''} | ${o.kvadrata||'—'}m²`;
}).join('\n')}
ZAKLJUČAK: [prosječna cijena/m², usporedba]
PREPORUKA: [direktna preporuka]
UPOZORENJE: [uknjiženo/ZK, instalacije, vlaga — uvijek napiši ovo]
Bosanski.`;
                aiAnaliza = await groqAI(aiPrompt, 400);
            }
        }
        res.json({ uspjeh: true, grupa1, grupa2, preciznost, aiAnaliza });
    } catch(e) {
        console.log('Dvije grupe greška:', e.message);
        res.json({ uspjeh: false, grupa1: [], grupa2: [], poruka: e.message });
    }
});

// ── FIX KATEGORIJE PO BRAND_ID ────────────────────────────
app.get('/api/fix-kategorije-brand', async (req, res) => {
    const mapa = { 7:'vozila-audi',11:'vozila-bmw',20:'vozila-ford',29:'vozila-fiat',30:'vozila-honda',35:'vozila-hyundai',39:'vozila-kia',46:'vozila-mazda',55:'vozila-mazda',56:'vozila-mercedes',64:'vozila-mitsubishi',65:'vozila-peugeot',69:'vozila-porsche',71:'vozila-renault',77:'vozila-skoda',89:'vozila-volkswagen',90:'vozila-volvo',2:'vozila-alfaromeo',4:'vozila-chevrolet',9:'vozila-citroen',15:'vozila-dacia',22:'vozila-jeep',33:'vozila-landrover',36:'vozila-mini',41:'vozila-nissan',47:'vozila-opel',57:'vozila-seat',62:'vozila-subaru',66:'vozila-suzuki',72:'vozila-toyota' };
    let ukupno = 0;
    for (const [brandId, kat] of Object.entries(mapa)) {
        const r = await pool.query(`UPDATE live_oglasi SET kategorija = $1 WHERE platforma = 'olx' AND kategorija = 'vozila' AND brand_id = $2`, [kat, parseInt(brandId)]);
        ukupno += r.rowCount;
    }
    res.json({ uspjeh: true, azurirano: ukupno });
});

// ── FIX KATEGORIJE ────────────────────────────────────────
app.get('/api/fix-kategorije', async (req, res) => {
    const brendovi = [
        { kljuc: ['volkswagen','vw ','golf','passat','tiguan','polo'], kat: 'vozila-volkswagen' },
        { kljuc: ['audi'], kat: 'vozila-audi' },
        { kljuc: ['mercedes','sprinter'], kat: 'vozila-mercedes' },
        { kljuc: ['bmw'], kat: 'vozila-bmw' },
        { kljuc: ['opel'], kat: 'vozila-opel' },
        { kljuc: ['peugeot'], kat: 'vozila-peugeot' },
        { kljuc: ['renault'], kat: 'vozila-renault' },
        { kljuc: ['toyota'], kat: 'vozila-toyota' },
        { kljuc: ['honda'], kat: 'vozila-honda' },
        { kljuc: ['ford'], kat: 'vozila-ford' },
        { kljuc: ['skoda','škoda'], kat: 'vozila-skoda' },
        { kljuc: ['seat'], kat: 'vozila-seat' },
        { kljuc: ['fiat'], kat: 'vozila-fiat' },
        { kljuc: ['citroen','citroën'], kat: 'vozila-citroen' },
        { kljuc: ['hyundai'], kat: 'vozila-hyundai' },
        { kljuc: ['kia'], kat: 'vozila-kia' },
        { kljuc: ['mazda'], kat: 'vozila-mazda' },
        { kljuc: ['nissan'], kat: 'vozila-nissan' },
        { kljuc: ['suzuki'], kat: 'vozila-suzuki' },
        { kljuc: ['volvo'], kat: 'vozila-volvo' },
        { kljuc: ['porsche'], kat: 'vozila-porsche' },
        { kljuc: ['land rover','landrover','range rover'], kat: 'vozila-landrover' },
        { kljuc: ['jeep'], kat: 'vozila-jeep' },
        { kljuc: ['mitsubishi'], kat: 'vozila-mitsubishi' },
        { kljuc: ['subaru'], kat: 'vozila-subaru' },
        { kljuc: ['dacia'], kat: 'vozila-dacia' },
        { kljuc: ['alfa romeo','alfa-romeo'], kat: 'vozila-alfaromeo' },
        { kljuc: ['mini cooper','mini one','mini clubman'], kat: 'vozila-mini' },
        { kljuc: ['chevrolet'], kat: 'vozila-chevrolet' },
    ];
    let ukupno = 0;
    for (const b of brendovi) {
        const uvjet = b.kljuc.map(k => `LOWER(naslov) LIKE '%${k.toLowerCase()}%'`).join(' OR ');
        const r = await pool.query(`UPDATE live_oglasi SET kategorija = $1 WHERE platforma = 'olx' AND kategorija = 'vozila' AND (${uvjet})`, [b.kat]);
        ukupno += r.rowCount;
    }
    res.json({ uspjeh: true, azurirano: ukupno });
});

// ── OLX FETCH ─────────────────────────────────────────────
async function fetchOLXKategorija(categoryId, kategorija) {
    try {
        const prvaStrana = await axios.get(`https://olx.ba/api/search?category_id=${categoryId}&per_page=40&page=1`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' }, timeout: 15000 });
        const lastPage = Math.min(prvaStrana.data.meta?.last_page || 1, 100);
        for (const o of (prvaStrana.data.data || [])) {
            try { await pool.query(`INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (link) DO NOTHING`, [o.title, o.display_price || 'Na upit', o.image || '', `https://www.olx.ba/artikal/${o.id}`, 'olx', kategorija]); } catch(e) {}
        }
        for (let stranica = 2; stranica <= lastPage; stranica++) {
            try {
                const response = await axios.get(`https://olx.ba/api/search?category_id=${categoryId}&per_page=40&page=${stranica}`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' }, timeout: 15000 });
                const oglasi = response.data.data || [];
                if (!oglasi.length) break;
                for (const o of oglasi) {
                    try { await pool.query(`INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (link) DO NOTHING`, [o.title, o.display_price || 'Na upit', o.image || '', `https://www.olx.ba/artikal/${o.id}`, 'olx', kategorija]); } catch(e) {}
                }
                await new Promise(r => setTimeout(r, 3000));
            } catch(e) {
                if (e.response?.status === 429) { await new Promise(r => setTimeout(r, 30000)); stranica--; }
            }
        }
        console.log(`OLX: ${kategorija} ZAVRŠENA`);
    } catch(e) { console.log(`OLX greška za ${kategorija}:`, e.message); }
}

async function autobumGet(page, katId) {
    const filters = encodeURIComponent('[{"field":"category_id","type":"eq","value":' + katId + '}]');
    const fields = encodeURIComponent('[]');
    const url = `https://api.autobum.ba/api/v1/articles?perPage=15&page=${page}&filters=${filters}&fieldsFilters=${fields}`;
    const response = await fetch2(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://autobum.ba/' } });
    return response.json();
}

async function fetchAutobum() {
    console.log('Autobum: počinjem fetch svih oglasa...');
    try {
        let sacuvano = 0, page = 1, imaSljedece = true, greskeBrojac = 0;
        while (imaSljedece) {
            try {
                const r = await autobumGet(page, 1);
                const oglasi = r.data || [];
                if (!oglasi.length) { console.log('Autobum: nema više oglasa.'); break; }
                greskeBrojac = 0;
                for (const o of oglasi) {
                    try {
                        const link = `https://autobum.ba/oglas/${o.id}`;
                        const dbRes = await pool.query(
                            `INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija, godiste, km, gorivo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (link) DO UPDATE SET cijena = EXCLUDED.cijena, godiste = EXCLUDED.godiste, km = EXCLUDED.km, gorivo = EXCLUDED.gorivo`,
                            [o.title, o.price || 'Na upit', o.image || '', link, 'autobum', 'vozila', o.year ? parseInt(o.year) : null, o.mileage ? parseInt(o.mileage) : null, o.fuel || null]
                        );
                        if (dbRes.rowCount > 0) sacuvano++;
                    } catch(e) {}
                }
                imaSljedece = !!(r.links && r.links.next);
                page++;
                if (page % 50 === 0) console.log(`Autobum: stranica ${page}, sacuvano ${sacuvano}`);
                await new Promise(resolve => setTimeout(resolve, 800));
            } catch(e) {
                greskeBrojac++;
                console.log(`Autobum stranica ${page} greška (${greskeBrojac}/5):`, e.message);
                await new Promise(resolve => setTimeout(resolve, 5000));
                if (greskeBrojac >= 5) { console.log('Autobum: previše grešaka, zaustavljam.'); break; }
            }
        }
        console.log(`Autobum ZAVRŠENO: ${sacuvano} novih oglasa, ${page} stranica`);
    } catch(e) { console.log('Autobum greška:', e.message); }
}

async function fetchSvaVozila() {
    console.log('OLX vozila: počinjem fetch...');
    try {
        const prvaStrana = await axios.get('https://olx.ba/api/search?category_id=18&per_page=40&page=1', { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' }, timeout: 15000 });
        const lastPage = Math.min(prvaStrana.data.meta?.last_page || 1, 500);
        console.log('OLX vozila: ' + (prvaStrana.data.meta?.total||0) + ' oglasa, ' + lastPage + ' stranica');
        let sacuvano = 0;
        for (const o of (prvaStrana.data.data || [])) {
            try { const dbRes = await pool.query('INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija, brand_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (link) DO NOTHING', [o.title, o.display_price || 'Na upit', o.image || '', 'https://www.olx.ba/artikal/' + o.id, 'olx', 'vozila', o.brand_id || null]); if (dbRes.rowCount > 0) sacuvano++; } catch(e) {}
        }
        for (let stranica = 2; stranica <= lastPage; stranica++) {
            try {
                const response = await axios.get('https://olx.ba/api/search?category_id=18&per_page=40&page=' + stranica, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' }, timeout: 15000 });
                const oglasi = response.data.data || [];
                if (!oglasi.length) break;
                for (const o of oglasi) {
                    try { const dbRes = await pool.query('INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija, brand_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (link) DO NOTHING', [o.title, o.display_price || 'Na upit', o.image || '', 'https://www.olx.ba/artikal/' + o.id, 'olx', 'vozila', o.brand_id || null]); if (dbRes.rowCount > 0) sacuvano++; } catch(e) {}
                }
                if (stranica % 50 === 0) console.log('OLX vozila: stranica ' + stranica + '/' + lastPage);
                await new Promise(r => setTimeout(r, 1500));
            } catch(e) {
                if (e.response?.status === 429) { await new Promise(r => setTimeout(r, 30000)); stranica--; }
            }
        }
        console.log('OLX vozila ZAVRŠENO. Novih: ' + sacuvano);
    } catch(e) { console.log('OLX vozila greška:', e.message); }
}

// ── EMAIL ─────────────────────────────────────────────────
function emailTemplate(naslov, sadrzaj) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f7f5f2;font-family:'Helvetica Neue',Arial,sans-serif;"><div style="max-width:580px;margin:0 auto;padding:32px 16px;"><div style="text-align:center;margin-bottom:24px;"><span style="font-size:24px;font-weight:800;color:#1a1a1a;">oglix<span style="color:#e65c00;">.ba</span></span></div><div style="background:white;border-radius:16px;padding:32px;border:1px solid rgba(0,0,0,0.08);"><h2 style="font-size:20px;font-weight:700;color:#1a1a1a;margin:0 0 16px 0;">${naslov}</h2>${sadrzaj}</div></div></body></html>`;
}

function posaljiEmail(to, subject, html) {
    return transporter.sendMail({ from: `"Oglix.ba" <${process.env.EMAIL_USER}>`, to, subject, html }).catch(e => console.log('Email greška:', e.message));
}

async function initAlerti() {
    await pool.query(`CREATE TABLE IF NOT EXISTS alerti (id SERIAL PRIMARY KEY, korisnik_email VARCHAR(100) NOT NULL, naziv VARCHAR(200), kljucna_rijec VARCHAR(200), kategorija VARCHAR(100), cijena_do NUMERIC, cijena_od NUMERIC, aktivan BOOLEAN DEFAULT true, zadnje_slanje TIMESTAMP, datum TIMESTAMP DEFAULT NOW())`);
    await pool.query(`ALTER TABLE alerti ADD COLUMN IF NOT EXISTS naziv VARCHAR(200)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pracenje_cijena (id SERIAL PRIMARY KEY, korisnik_email VARCHAR(100) NOT NULL, oglas_link TEXT NOT NULL, oglas_naslov TEXT, oglas_slika TEXT, cijena_pocetna NUMERIC, cijena_trenutna NUMERIC, platforma VARCHAR(50), aktivan BOOLEAN DEFAULT true, datum TIMESTAMP DEFAULT NOW(), UNIQUE(korisnik_email, oglas_link))`);
    console.log('Alerti inicijalizovani!');
}
initAlerti();

app.post('/api/alert', async (req, res) => {
    const { email, naziv, kljucna_rijec, kategorija, cijena_od, cijena_do } = req.body;
    if (!email || !kljucna_rijec) return res.json({ uspjeh: false, poruka: 'Email i ključna riječ su obavezni!' });
    try {
        const result = await pool.query(`INSERT INTO alerti (korisnik_email, naziv, kljucna_rijec, kategorija, cijena_od, cijena_do) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [email, naziv || kljucna_rijec, kljucna_rijec, kategorija || null, cijena_od || null, cijena_do || null]);
        posaljiEmail(email, '✅ Alert kreiran — Oglix.ba', emailTemplate('Alert je aktiviran!', `<p>Obavijestit ćemo te čim se pojavi oglas: <strong>${kljucna_rijec}</strong></p>`));
        res.json({ uspjeh: true, id: result.rows[0].id });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});

app.get('/api/alerti', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.json({ uspjeh: false });
    const result = await pool.query(`SELECT * FROM alerti WHERE korisnik_email = $1 AND aktivan = true ORDER BY datum DESC`, [email]);
    res.json({ uspjeh: true, alerti: result.rows });
});

app.delete('/api/alert/:id', async (req, res) => {
    await pool.query(`UPDATE alerti SET aktivan = false WHERE id = $1`, [req.params.id]);
    res.json({ uspjeh: true });
});

app.post('/api/prati-oglas-cijenu', async (req, res) => {
    const { email, oglas_link, oglas_naslov, oglas_slika, cijena, platforma } = req.body;
    if (!email || !oglas_link) return res.json({ uspjeh: false });
    try {
        await pool.query(`INSERT INTO pracenje_cijena (korisnik_email, oglas_link, oglas_naslov, oglas_slika, cijena_pocetna, cijena_trenutna, platforma) VALUES ($1,$2,$3,$4,$5,$5,$6) ON CONFLICT (korisnik_email, oglas_link) DO NOTHING`, [email, oglas_link, oglas_naslov, oglas_slika, parseCijena(cijena), platforma || 'olx']);
        res.json({ uspjeh: true });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});

app.get('/api/pracenje-cijena', async (req, res) => {
    const { email } = req.query;
    const result = await pool.query(`SELECT * FROM pracenje_cijena WHERE korisnik_email = $1 AND aktivan = true ORDER BY datum DESC`, [email]);
    res.json({ uspjeh: true, pracenja: result.rows });
});

app.delete('/api/prati-oglas-cijenu/:id', async (req, res) => {
    await pool.query(`UPDATE pracenje_cijena SET aktivan = false WHERE id = $1`, [req.params.id]);
    res.json({ uspjeh: true });
});

async function provjeriAlerte(noviOglasi) {
    if (!noviOglasi || !noviOglasi.length) return;
    try {
        const alerti = await pool.query(`SELECT * FROM alerti WHERE aktivan = true`);
        if (!alerti.rows.length) return;
        for (const alert of alerti.rows) {
            if (alert.zadnje_slanje && (new Date() - new Date(alert.zadnje_slanje)) < 3600000) continue;
            const kljuc = alert.kljucna_rijec.toLowerCase();
            const podudarni = noviOglasi.filter(o => {
                if (!o.naslov.toLowerCase().includes(kljuc)) return false;
                if (alert.kategorija && o.kategorija && !o.kategorija.includes(alert.kategorija)) return false;
                const cijenaNum = parseCijena(o.cijena);
                if (alert.cijena_do && cijenaNum > 0 && cijenaNum > parseFloat(alert.cijena_do)) return false;
                if (alert.cijena_od && cijenaNum > 0 && cijenaNum < parseFloat(alert.cijena_od)) return false;
                return true;
            });
            if (!podudarni.length) continue;
            const oglasHtml = podudarni.slice(0, 5).map(o => `<a href="${o.link}" style="display:block;text-decoration:none;color:inherit;border:1px solid rgba(0,0,0,0.08);border-radius:10px;padding:14px;margin-bottom:10px;"><div style="font-weight:600;color:#1a1a1a;font-size:14px;">${o.naslov.substring(0,80)}</div><div style="color:#e65c00;font-weight:700;">${o.cijena}</div></a>`).join('');
            await posaljiEmail(alert.korisnik_email, `🔔 ${podudarni.length} novi oglas za "${alert.naziv}" — Oglix.ba`, emailTemplate(`Pronađeno ${podudarni.length} novih oglasa!`, `<p>Novi oglasi za <strong>"${alert.naziv}"</strong>:</p>${oglasHtml}`));
            await pool.query(`UPDATE alerti SET zadnje_slanje = NOW() WHERE id = $1`, [alert.id]);
        }
    } catch(e) { console.log('Greška provjere alertā:', e.message); }
}

async function provjeriPadCijena() {
    try {
        const pracenja = await pool.query(`SELECT * FROM pracenje_cijena WHERE aktivan = true AND platforma = 'olx'`);
        if (!pracenja.rows.length) return;
        for (const p of pracenja.rows) {
            try {
                const olxId = p.oglas_link.split('/artikal/')[1];
                if (!olxId) continue;
                const res2 = await axios.get(`https://olx.ba/api/listings/${olxId}`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 5000 });
                const novaCijena = parseCijena(res2.data.display_price);
                const staraCijena = parseFloat(p.cijena_trenutna) || 0;
                if (res2.data.available === false) {
                    await pool.query(`UPDATE pracenje_cijena SET aktivan = false WHERE id = $1`, [p.id]);
                    await posaljiEmail(p.korisnik_email, `❌ Oglas koji pratiš je prodan — Oglix.ba`, emailTemplate('Oglas je prodan', `<p>${p.oglas_naslov}</p>`));
                    continue;
                }
                if (novaCijena > 0 && staraCijena > 0 && novaCijena < staraCijena - 100) {
                    const razlika = Math.round(staraCijena - novaCijena);
                    const posto = Math.round(razlika / staraCijena * 100);
                    await pool.query(`UPDATE pracenje_cijena SET cijena_trenutna = $1 WHERE id = $2`, [novaCijena, p.id]);
                    await posaljiEmail(p.korisnik_email, `📉 Cijena pala za ${razlika} KM — Oglix.ba`, emailTemplate(`Cijena snižena za ${razlika} KM (${posto}%)!`, `<p>${p.oglas_naslov}</p><a href="${p.oglas_link}" style="color:#e65c00;">Pogledaj oglas →</a>`));
                } else if (novaCijena > 0 && novaCijena !== staraCijena) {
                    await pool.query(`UPDATE pracenje_cijena SET cijena_trenutna = $1 WHERE id = $2`, [novaCijena, p.id]);
                }
                await new Promise(r => setTimeout(r, 800));
            } catch(e) {
                if (e.response?.status === 404) await pool.query(`UPDATE pracenje_cijena SET aktivan = false WHERE id = $1`, [p.id]);
            }
        }
    } catch(e) { console.log('Greška provjere cijena:', e.message); }
}

setInterval(provjeriPadCijena, 60 * 60 * 1000);

async function posaljiTjedniDigest() {
    try {
        const korisnici = await pool.query(`SELECT DISTINCT korisnik_email FROM alerti WHERE aktivan = true`);
        for (const k of korisnici.rows) {
            const alerti = await pool.query(`SELECT * FROM alerti WHERE korisnik_email = $1 AND aktivan = true`, [k.korisnik_email]);
            if (!alerti.rows.length) continue;
            let sadrzaj = '';
            for (const alert of alerti.rows.slice(0, 3)) {
                const oglasi = await pool.query(`SELECT * FROM live_oglasi WHERE naslov ILIKE $1 AND datum > NOW() - INTERVAL '7 days' ORDER BY datum DESC LIMIT 3`, [`%${alert.kljucna_rijec}%`]);
                if (!oglasi.rows.length) continue;
                sadrzaj += `<h3>${alert.naziv}</h3>` + oglasi.rows.map(o => `<a href="${o.link}">${o.naslov} — ${o.cijena}</a>`).join('<br>');
            }
            if (!sadrzaj) continue;
            await posaljiEmail(k.korisnik_email, `📊 Tjedni pregled — Oglix.ba`, emailTemplate('Tvoj tjedni pregled', sadrzaj));
        }
    } catch(e) { console.log('Digest greška:', e.message); }
}

setInterval(() => {
    const now = new Date();
    if (now.getDay() === 1 && now.getHours() === 9 && now.getMinutes() < 5) posaljiTjedniDigest();
}, 5 * 60 * 1000);

async function fetchSveKategorije() {
    console.log('Pokrećem fetch...');
    await fetchSvaVozila();
    const ostale = [
        { id: '21', naziv: 'motocikli' }, { id: '22', naziv: 'bicikli' },
        { id: '426', naziv: 'nautika' }, { id: '2457', naziv: 'atv-quad' },
        { id: '23', naziv: 'nekretnine-stanovi' }, { id: '24', naziv: 'nekretnine-kuce' },
        { id: '29', naziv: 'nekretnine-zemljista' }, { id: '25', naziv: 'nekretnine-poslovni' },
        { id: '31', naziv: 'elektronika-mobiteli' }, { id: '1495', naziv: 'elektronika-tableti' },
        { id: '2076', naziv: 'elektronika-satovi' }, { id: '252', naziv: 'elektronika-dijelovi-mobiteli' },
        { id: '34', naziv: 'elektronika-bluetooth' }, { id: '38', naziv: 'elektronika-desktop' },
        { id: '39', naziv: 'elektronika-laptopi' }, { id: '42', naziv: 'elektronika-oprema' },
        { id: '75', naziv: 'elektronika-serveri' }, { id: '46', naziv: 'elektronika-bijela-tehnika' },
        { id: '45', naziv: 'elektronika-tv' }, { id: '2392', naziv: 'elektronika-zvucnici' },
        { id: '2129', naziv: 'elektronika-vr' }, { id: '225', naziv: 'masine-alati' },
    ];
    for (const kat of ostale) {
        await fetchOLXKategorija(kat.id, kat.naziv);
        await new Promise(r => setTimeout(r, 2000));
    }
    await fetchAutobum();
    console.log('Fetch završen!');
}

app.get('/api/run-autobum', async (req, res) => {
    res.json({ uspjeh: true, poruka: 'Autobum fetch pokrenut!' });
    fetchAutobum();
});

app.get('/api/autobum-status', async (req, res) => {
    try {
        const r = await pool.query(`SELECT COUNT(*) as ukupno FROM live_oglasi WHERE platforma = 'autobum'`);
        const zadnji = await pool.query(`SELECT datum FROM live_oglasi WHERE platforma = 'autobum' ORDER BY datum DESC LIMIT 1`);
        res.json({ uspjeh: true, ukupno: parseInt(r.rows[0].ukupno), zadnji_oglas: zadnji.rows[0]?.datum || null });
    } catch(e) { res.json({ uspjeh: false }); }
});

app.get('/api/test-autobum', async (req, res) => {
    try {
        const data = await autobumGet(1, 1);
        res.json({ uspjeh: true, keys: Object.keys(data), count: data.data?.length, oglas: data.data?.[0], links: data.links, meta: data.meta });
    } catch(e) { res.json({ uspjeh: false, greska: e.message }); }
});

// ── PRAĆENJE PRODANIH OGLASA ──────────────────────────────
async function checkajProdaneOglase() {
    try {
        const aktivni = await pool.query(`SELECT id, link, datum FROM live_oglasi WHERE platforma = 'olx' AND available = true AND datum > NOW() - INTERVAL '90 days' LIMIT 500`);
        let prodano = 0;
        for (const oglas of aktivni.rows) {
            try {
                const olxId = oglas.link.split('/artikal/')[1];
                if (!olxId) continue;
                const res2 = await axios.get(`https://olx.ba/api/listings/${olxId}`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 5000 });
                if (res2.data.available === false) {
                    const danaDo = Math.round((new Date() - new Date(oglas.datum)) / (1000 * 60 * 60 * 24));
                    await pool.query(`UPDATE live_oglasi SET available = false, datum_nestanka = NOW(), dana_do_prodaje = $1 WHERE id = $2`, [danaDo, oglas.id]);
                    prodano++;
                }
                await new Promise(r => setTimeout(r, 500));
            } catch(e) {
                if (e.response?.status === 404) {
                    const danaDo = Math.round((new Date() - new Date(oglas.datum)) / (1000 * 60 * 60 * 24));
                    await pool.query(`UPDATE live_oglasi SET available = false, datum_nestanka = NOW(), dana_do_prodaje = $1 WHERE id = $2`, [danaDo, oglas.id]);
                    prodano++;
                }
            }
        }
        console.log(`Prodani oglasi: ${prodano} detektovano`);
    } catch(e) { console.log('Greška checkanja prodanih:', e.message); }
}

setInterval(checkajProdaneOglase, 60 * 60 * 1000);

// ── STATISTIKE ────────────────────────────────────────────
app.get('/api/statistike', async (req, res) => {
    try {
        const kategorija = req.query.kategorija || 'vozila';
        const ukupno = await pool.query(`SELECT COUNT(*) as ukupno, COUNT(CASE WHEN available = false THEN 1 END) as prodano FROM live_oglasi WHERE kategorija LIKE $1`, [kategorija + '%']);
        const prosjecno = await pool.query(`SELECT ROUND(AVG(dana_do_prodaje)) as prosjek, MIN(dana_do_prodaje) as min, MAX(dana_do_prodaje) as max FROM live_oglasi WHERE kategorija LIKE $1 AND dana_do_prodaje IS NOT NULL`, [kategorija + '%']);
        const poBrojevu = await pool.query(`SELECT TO_CHAR(datum_nestanka, 'YYYY-MM') as mjesec, COUNT(*) as prodano FROM live_oglasi WHERE kategorija LIKE $1 AND datum_nestanka IS NOT NULL GROUP BY mjesec ORDER BY mjesec DESC LIMIT 12`, [kategorija + '%']);
        const brendovi = await pool.query(`SELECT kategorija, ROUND(AVG(dana_do_prodaje)) as prosjek_dana, COUNT(*) as prodano FROM live_oglasi WHERE kategorija LIKE $1 AND dana_do_prodaje IS NOT NULL GROUP BY kategorija ORDER BY prosjek_dana ASC LIMIT 10`, [kategorija + '%']);
        const cijene = await pool.query(`SELECT ROUND(AVG(cijena_num)) as prosjek, MIN(cijena_num) as min, MAX(cijena_num) as max, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cijena_num) as medijana FROM live_oglasi WHERE kategorija LIKE $1 AND available = false AND cijena_num > 0`, [kategorija + '%']);
        res.json({ uspjeh: true, ukupno: parseInt(ukupno.rows[0].ukupno), prodano: parseInt(ukupno.rows[0].prodano), prosjekDana: prosjecno.rows[0], poBrojevu: poBrojevu.rows, brendovi: brendovi.rows, cijene: cijene.rows[0] });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});

app.get('/api/statistike/vozila', async (req, res) => {
    try {
        const boje = await pool.query(`SELECT boja, ROUND(AVG(dana_do_prodaje)) as prosjek_dana, COUNT(*) as prodano FROM live_oglasi WHERE kategorija LIKE 'vozila%' AND boja IS NOT NULL AND dana_do_prodaje IS NOT NULL GROUP BY boja ORDER BY prosjek_dana ASC LIMIT 10`);
        const gorivo = await pool.query(`SELECT gorivo, ROUND(AVG(dana_do_prodaje)) as prosjek_dana, COUNT(*) as prodano FROM live_oglasi WHERE kategorija LIKE 'vozila%' AND gorivo IS NOT NULL AND dana_do_prodaje IS NOT NULL GROUP BY gorivo ORDER BY prosjek_dana ASC`);
        const godista = await pool.query(`SELECT godiste, COUNT(*) as prodano, ROUND(AVG(dana_do_prodaje)) as prosjek_dana FROM live_oglasi WHERE kategorija LIKE 'vozila%' AND godiste IS NOT NULL AND dana_do_prodaje IS NOT NULL GROUP BY godiste ORDER BY prodano DESC LIMIT 15`);
        const brendovi = await pool.query(`SELECT kategorija, COUNT(*) as ukupno, COUNT(CASE WHEN available = false THEN 1 END) as prodano, ROUND(AVG(CASE WHEN available = false THEN dana_do_prodaje END)) as prosjek_dana FROM live_oglasi WHERE kategorija LIKE 'vozila-%' GROUP BY kategorija ORDER BY prodano DESC LIMIT 15`);
        const kilometraza = await pool.query(`SELECT CASE WHEN km < 50000 THEN '0-50k km' WHEN km < 100000 THEN '50-100k km' WHEN km < 150000 THEN '100-150k km' WHEN km < 200000 THEN '150-200k km' ELSE '200k+ km' END as rang, COUNT(*) as prodano, ROUND(AVG(dana_do_prodaje)) as prosjek_dana FROM live_oglasi WHERE kategorija LIKE 'vozila%' AND km IS NOT NULL AND dana_do_prodaje IS NOT NULL GROUP BY rang ORDER BY prosjek_dana ASC`);
        const cijenovni = await pool.query(`SELECT CASE WHEN cijena_num < 5000 THEN 'Do 5k KM' WHEN cijena_num < 10000 THEN '5-10k KM' WHEN cijena_num < 15000 THEN '10-15k KM' WHEN cijena_num < 20000 THEN '15-20k KM' WHEN cijena_num < 30000 THEN '20-30k KM' ELSE '30k+ KM' END as rang, COUNT(*) as prodano, ROUND(AVG(dana_do_prodaje)) as prosjek_dana FROM live_oglasi WHERE kategorija LIKE 'vozila%' AND cijena_num > 0 AND dana_do_prodaje IS NOT NULL GROUP BY rang ORDER BY prosjek_dana ASC`);
        res.json({ uspjeh: true, boje: boje.rows, gorivo: gorivo.rows, godista: godista.rows, brendovi: brendovi.rows, kilometraza: kilometraza.rows, cijenovni: cijenovni.rows });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});

app.post('/api/kalkulator-vrijednosti', async (req, res) => {
    try {
        const { kategorija, brand_kategorija, godiste, gorivo } = req.body;
        let uvjeti = [`kategorija = $1`, `available = false`, `cijena_num > 0`];
        let params = [brand_kategorija || kategorija];
        let i = 2;
        if (godiste) { uvjeti.push(`ABS(godiste - $${i++}) <= 2`); params.push(parseInt(godiste)); }
        if (gorivo) { uvjeti.push(`gorivo ILIKE $${i++}`); params.push(gorivo); }
        const result = await pool.query(`SELECT COUNT(*) as uzorak, ROUND(AVG(cijena_num)) as prosjek, ROUND(MIN(cijena_num)) as min, ROUND(MAX(cijena_num)) as max, ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY cijena_num)) as q1, ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY cijena_num)) as q3, ROUND(AVG(dana_do_prodaje)) as prosjek_dana FROM live_oglasi WHERE ${uvjeti.join(' AND ')}`, params);
        const r = result.rows[0];
        res.json({ uspjeh: true, uzorak: parseInt(r.uzorak), prosjek: parseInt(r.prosjek) || 0, min: parseInt(r.min) || 0, max: parseInt(r.max) || 0, preporucenaOd: parseInt(r.q1) || 0, preporucenaDo: parseInt(r.q3) || 0, prosjekDana: parseInt(r.prosjek_dana) || 0 });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});

app.get('/api/check-prodane', async (req, res) => {
    res.json({ uspjeh: true, poruka: 'Checkanje prodanih pokrenuto!' });
    checkajProdaneOglase();
});

// ── OGLIX BIZNIS ──────────────────────────────────────────
app.post('/api/biznis-prijava', async (req, res) => {
    const { ime, firma, email, telefon, plan, poruka } = req.body;
    if (!ime || !email || !telefon) return res.json({ uspjeh: false });
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS biznis_prijave (id SERIAL PRIMARY KEY, ime VARCHAR(100), firma VARCHAR(100), email VARCHAR(100), telefon VARCHAR(50), plan VARCHAR(100), poruka TEXT, datum TIMESTAMP DEFAULT NOW())`);
        await pool.query(`INSERT INTO biznis_prijave (ime, firma, email, telefon, plan, poruka) VALUES ($1,$2,$3,$4,$5,$6)`, [ime, firma||null, email, telefon, plan||null, poruka||null]);
        transporter.sendMail({ from: process.env.EMAIL_USER, to: process.env.EMAIL_USER, subject: `🎯 Nova Oglix Biznis prijava — ${ime}`, html: `<h2>Nova prijava!</h2><p>Ime: ${ime}<br>Email: ${email}<br>Telefon: ${telefon}<br>Plan: ${plan||'—'}</p>` }).catch(() => {});
        transporter.sendMail({ from: `"Oglix Biznis" <${process.env.EMAIL_USER}>`, to: email, subject: '✅ Primili smo vašu prijavu — Oglix Biznis', html: `<h2>Zdravo ${ime}!</h2><p>Kontaktiramo vas u roku od 24 sata.</p>` }).catch(() => {});
        res.json({ uspjeh: true });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});

app.get('/api/moj-plan', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.json({ uspjeh: false });
    try {
        const r = await pool.query('SELECT plan, plan_datum_isteka FROM korisnici WHERE email = $1', [email]);
        if (!r.rows.length) return res.json({ uspjeh: false });
        res.json({ uspjeh: true, plan: r.rows[0].plan || 'free', datum_isteka: r.rows[0].plan_datum_isteka });
    } catch(e) { res.json({ uspjeh: false }); }
});

app.post('/api/admin/promijeni-plan', async (req, res) => {
    const { email, plan, mjeseci, tajni_kljuc } = req.body;
    if (tajni_kljuc !== process.env.ADMIN_KEY) return res.status(403).json({ uspjeh: false, poruka: 'Nedozvoljen pristup!' });
    try {
        const datumIsteka = mjeseci ? new Date(Date.now() + mjeseci * 30 * 24 * 60 * 60 * 1000) : null;
        await pool.query('UPDATE korisnici SET plan = $1, plan_datum_isteka = $2 WHERE email = $3', [plan, datumIsteka, email]);
        res.json({ uspjeh: true, poruka: `Plan za ${email} promijenjen u ${plan}` });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});

// ── OLX DETALJI POSTEPENO ────────────────────────────────
async function popuniOlxDetalje() {
    try {
        const oglasi = await pool.query(`SELECT id, link FROM live_oglasi WHERE platforma = 'olx' AND kategorija LIKE 'vozila%' AND godiste IS NULL AND km IS NULL ORDER BY datum DESC LIMIT 200`);
        if (!oglasi.rows.length) { console.log('OLX detalji: svi su popunjeni!'); return; }
        console.log(`OLX detalji: popunjavam ${oglasi.rows.length} oglasa...`);
        let popunjeno = 0;
        for (const oglas of oglasi.rows) {
            try {
                const olxId = oglas.link.split('/artikal/')[1];
                if (!olxId) continue;
                const { data, attrs } = await dohvatiOlxDetalje(olxId);
                const godiste = attrs['godiste'] ? parseInt(attrs['godiste']) : null;
                const km = attrs['kilometra-a'] ? parseInt(attrs['kilometra-a']) : null;
                const gorivo = attrs['gorivo'] || null;
                const kw = attrs['kilovata-kw'] ? parseInt(attrs['kilovata-kw']) : null;
                const boja = attrs['boja'] || null;
                const grad = data.cities?.[0]?.name || null;
                const cijena_num = parseCijena(data.display_price);
                await pool.query(`UPDATE live_oglasi SET godiste = $1, km = $2, gorivo = $3, kw = $4, boja = $5, grad = $6, cijena_num = $7 WHERE id = $8`, [godiste, km, gorivo, kw, boja, grad, cijena_num || null, oglas.id]);
                popunjeno++;
                await new Promise(r => setTimeout(r, 600));
            } catch(e) {
                if (e.response?.status === 404) await pool.query(`UPDATE live_oglasi SET available = false WHERE id = $1`, [oglas.id]);
            }
        }
        console.log(`OLX detalji: popunjeno ${popunjeno} oglasa.`);
    } catch(e) { console.log('OLX detalji greška:', e.message); }
}

setInterval(popuniOlxDetalje, 2 * 60 * 60 * 1000 + 30 * 60 * 1000);
setTimeout(popuniOlxDetalje, 5 * 60 * 1000);

app.get('/api/popuni-olx-detalje', async (req, res) => {
    res.json({ uspjeh: true, poruka: 'Pokrenuto! Prati Railway logs.' });
    popuniOlxDetalje();
});

// ── AI USPOREDBA OGLASA ───────────────────────────────────
app.post('/api/compare-ai', async (req, res) => {
    try {
        const { oglasi } = req.body;
        if (!oglasi || oglasi.length < 2) return res.json({ uspjeh: false, poruka: 'Minimum 2 oglasa!' });

        const detalji = await Promise.all(oglasi.map(async (o, idx) => {
            let d = { kategorija_tip: 'ostalo' };
            try {
                if (o.platforma === 'olx' && o.link) {
                    const olxId = o.link.split('/artikal/')[1];
                    if (olxId) {
                        const det = await dohvatiOlxDetalje(olxId);
                        const attrs = det.attrs;
                        d = {
                            kategorija_tip: 'vozila',
                            godiste: attrs['godiste'] || null,
                            gorivo: attrs['gorivo'] || null,
                            km: attrs['kilometra-a'] || null,
                            kubikaza: attrs['kubikaza'] || null,
                            kw: attrs['kilovata-kw'] || null,
                            transmisija: attrs['transmisija'] || null,
                            boja: attrs['boja'] || null,
                            grad: det.data.cities?.[0]?.name || null,
                        };
                    }
                } else if (o.platforma === 'autobum' && o.link) {
                    const abId = o.link.split('/oglas/')[1];
                    if (abId) {
                        const abRes = await fetch2(`https://api.autobum.ba/api/v1/articles/${abId}`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
                        const abData = await abRes.json();
                        const o2 = abData.data || abData;
                        d = { kategorija_tip: 'vozila', godiste: o2.year || null, gorivo: o2.fuel || null, km: o2.mileage || null, kw: o2.power_kw || null, grad: o2.location?.city || null };
                    }
                }
            } catch(e) {}
            return { idx, oglas: o, detalji: d };
        }));

        const oglasInfo = detalji.map((item, i) => {
            const o = item.oglas;
            const d = item.detalji;
            const c = parseCijena(o.cijenaStr || o.cijena);
            const linije = [
                `OGLAS #${i+1}`,
                `Naziv: ${o.naslov}`,
                `Cijena: ${o.cijenaStr || o.cijena}${c > 0 ? ' (' + c.toLocaleString() + ' KM)' : ''}`,
                `Platforma: ${(o.platforma || 'olx').toUpperCase()}`,
            ];
            if (d.godiste) linije.push(`Godiste: ${d.godiste}`);
            if (d.gorivo) linije.push(`Gorivo: ${d.gorivo}`);
            if (d.km) linije.push(`Kilometraza: ${parseInt(d.km).toLocaleString()} km`);
            if (d.kubikaza) linije.push(`Motor: ${d.kubikaza}L`);
            if (d.kw) linije.push(`Snaga: ${d.kw} kW (${Math.round(d.kw * 1.36)} KS)`);
            if (d.transmisija) linije.push(`Mjenjac: ${d.transmisija}`);
            if (d.boja) linije.push(`Boja: ${d.boja}`);
            if (d.grad) linije.push(`Lokacija: ${d.grad}`);
            return linije.join('\n');
        }).join('\n\n');

        const prompt = `Ti si vrhunski strucnjak za kupovinu vozila u BiH sa 20 godina iskustva. Poznajes trzisne vrijednosti i das konkretne direktne savjete.

Kupac trazi usporedbu ${oglasi.length} oglasa:

${oglasInfo}

Uradi kompletnu analizu i rangiraj oglase.

Format:

UKUPNA ANALIZA:
[3-4 recenice o ukupnom stanju trzista za ove oglase]

OGLAS #1: [naziv]
[Analiza: je li cijena fer? Sta je dobro, sta lose?]
Score: [0-100]

OGLAS #2: [naziv]
[Analiza]
Score: [0-100]

RANG:
1. #X - [razlog]
2. #X - [razlog]
3. #X - [razlog]

PREPORUKA:
[Jedna direktna recenica koji oglas kupiti i zasto]

UPOZORENJE:
[Samo ako postoji oglas koji je jasno preskup ili sumnjiv]

Budi konkretan. Koristi cijene i procente. Bosanski jezik.`;

        const aiTekst = await groqAI(prompt, 1200);
        if (!aiTekst) return res.json({ uspjeh: false });

        // Izvuci score-ove
        const scores = [];
        const scoreRegex = /OGLAS #(\d+)[^\n]*\n[\s\S]*?Score:\s*(\d+)/gi;
        let match;
        while ((match = scoreRegex.exec(aiTekst)) !== null) {
            const oglasIdx = parseInt(match[1]) - 1;
            const score = parseInt(match[2]);
            if (oglasIdx >= 0 && oglasIdx < oglasi.length) {
                scores.push({ oglas_idx: oglasIdx, naziv: (oglasi[oglasIdx].naslov || '').substring(0, 35), score });
            }
        }
        scores.sort((a, b) => b.score - a.score);

        // Izvuci preporuku
        const verdictMatch = aiTekst.match(/PREPORUKA:\s*([\s\S]*?)(?=\n\n|\nUPOZORENJE:|$)/i);
        const verdict = verdictMatch ? verdictMatch[1].trim() : null;

        res.json({ uspjeh: true, analiza: aiTekst, scores, verdict });

    } catch(e) {
        console.log('Compare AI greška:', e.message);
        res.json({ uspjeh: false, poruka: e.message });
    }
});

// ── DEAL RATING ENDPOINT ─────────────────────────────────
app.get('/api/deal-rating/:id', async (req, res) => {
    try {
        const oglas = await pool.query('SELECT * FROM live_oglasi WHERE id = $1', [req.params.id]);
        if (!oglas.rows.length) return res.json({ uspjeh: false });
        const o = oglas.rows[0];
        const cijena = parseFloat(o.cijena_num) || 0;
        if (!cijena || !o.kategorija) return res.json({ uspjeh: true, rating: 'unknown', score: 50 });

        // Uzmi prosjek slicnih oglasa (ista kategorija, +-3 god ako ima)
        const slicni = await pool.query(
            `SELECT AVG(cijena_num) as avg, MIN(cijena_num) as min, MAX(cijena_num) as max, COUNT(*) as broj
             FROM live_oglasi WHERE kategorija = $1 AND cijena_num > 0 AND cijena_num < 500000 AND id != $2`,
            [o.kategorija, o.id]
        );
        if (!slicni.rows[0] || slicni.rows[0].broj < 3) return res.json({ uspjeh: true, rating: 'unknown', score: 50 });

        const avg = parseFloat(slicni.rows[0].avg);
        const min = parseFloat(slicni.rows[0].min);
        const ratio = cijena / avg;

        let rating, score, label, boja;
        if (ratio < 0.82) { rating = 'odlicno'; score = 95; label = 'Odlicno'; boja = '#27500A'; pozadina = '#EAF3DE'; }
        else if (ratio < 0.93) { rating = 'dobro'; score = 78; label = 'Dobra cijena'; boja = '#3B6D11'; pozadina = '#EAF3DE'; }
        else if (ratio < 1.05) { rating = 'fer'; score = 60; label = 'Fer cijena'; boja = '#633806'; pozadina = '#FAEEDA'; }
        else if (ratio < 1.18) { rating = 'skupo'; score = 35; label = 'Skuplje'; boja = '#791F1F'; pozadina = '#FCEBEB'; }
        else { rating = 'izbjegavaj'; score = 15; label = 'Izbjegavaj'; boja = '#501313'; pozadina = '#FCEBEB'; }

        res.json({ uspjeh: true, rating, score, label, boja, pozadina, avg: Math.round(avg), broj: parseInt(slicni.rows[0].broj) });
    } catch(e) {
        res.json({ uspjeh: false, poruka: e.message });
    }
});

// ── SCAM DETECTION ENDPOINT ──────────────────────────────
app.post('/api/scam-check', async (req, res) => {
    try {
        const { id, naslov, cijena, platforma, kategorija } = req.body;
        const cijenaNum = parseCijena(cijena) || 0;
        let flags = [];
        let scamScore = 0;

        // 1. Provjeri cijenu vs prosjek
        if (cijenaNum > 0 && kategorija) {
            const avg = await pool.query(
                'SELECT AVG(cijena_num) as avg FROM live_oglasi WHERE kategorija = $1 AND cijena_num > 0 AND cijena_num < 500000',
                [kategorija]
            );
            if (avg.rows[0]?.avg) {
                const ratio = cijenaNum / parseFloat(avg.rows[0].avg);
                if (ratio < 0.50) { flags.push('Cijena je vise od 50% ispod prosjeka za ovu kategoriju'); scamScore += 40; }
                else if (ratio < 0.65) { flags.push('Cijena je znatno ispod trhisnog prosjeka'); scamScore += 20; }
            }
        }

        // 2. Kljucne rijeci prevare u naslovu
        const prevaraRijeci = ['inostranstvo', 'njemacka', 'austrija', 'uk', 'western union', 'avans', 'depozit', 'kurirska', 'pouzecem', 'garantujem'];
        const naslovLower = (naslov || '').toLowerCase();
        prevaraRijeci.forEach(r => { if (naslovLower.includes(r)) { flags.push('Oglas spominje: "' + r + '" — cestacrvena zastavica prevare'); scamScore += 25; } });

        // 3. Preniska cijena apsolutno
        if (cijenaNum > 0 && cijenaNum < 50 && kategorija && kategorija.includes('vozila')) {
            flags.push('Cijena vozila je nerealno niska');
            scamScore += 50;
        }

        scamScore = Math.min(scamScore, 100);
        let rizik, boja, poruka;
        if (scamScore >= 60) { rizik = 'visok'; boja = '#FCEBEB'; poruka = 'Visok rizik prevare — budi oprezan'; }
        else if (scamScore >= 30) { rizik = 'srednji'; boja = '#FAEEDA'; poruka = 'Provjeri prodavaca prije kupovine'; }
        else { rizik = 'nizak'; boja = '#EAF3DE'; poruka = 'Bez ociglednih znakova prevare'; }

        res.json({ uspjeh: true, scamScore, rizik, boja, poruka, flags });
    } catch(e) {
        res.json({ uspjeh: false, poruka: e.message });
    }
});

// ── AI PRETRAGA PRIRODNIM JEZIKOM ────────────────────────
app.post('/api/ai-pretraga', async (req, res) => {
    try {
        const { upit } = req.body;
        const prompt = `Korisnik trazi oglas na BiH marketplace: "${upit}"

Izvuci parametre pretrage i vrati SAMO JSON bez objasnjenja:
{
  "q": "kljucna rijec za pretragu",
  "kategorija": "vozila|elektronika|nekretnine|masine|motocikli|ostalo",
  "cijena_od": null_ili_broj,
  "cijena_do": null_ili_broj,
  "gorivo": null_ili_"Dizel|Benzin|Hibrid|Elektricni",
  "godiste_od": null_ili_godina,
  "km_do": null_ili_broj,
  "sort": "novo|cijena_asc|cijena_desc"
}`;
        const odgovor = await groqAI(prompt, 300);
        let params;
        try {
            const json = odgovor.replace(/```json|```/g, '').trim();
            params = JSON.parse(json);
        } catch(e) {
            params = { q: upit };
        }
        res.json({ uspjeh: true, params });
    } catch(e) {
        res.json({ uspjeh: false, poruka: e.message });
    }
});

// ── HISTORIJA CIJENE ─────────────────────────────────────
app.get('/api/historija-cijene/:id', async (req, res) => {
    try {
        // Uzmi trenutni oglas
        const oglas = await pool.query('SELECT * FROM live_oglasi WHERE id = $1', [req.params.id]);
        if (!oglas.rows.length) return res.json({ uspjeh: false });
        const o = oglas.rows[0];

        // Uzmi historiju iz tabele (ako postoji)
        let historija = [];
        try {
            const hist = await pool.query(
                'SELECT cijena_num, datum FROM cijena_historija WHERE oglas_link = $1 ORDER BY datum ASC',
                [o.link]
            );
            historija = hist.rows;
        } catch(e) { /* tabela mozda ne postoji jos */ }

        // Ako nema historije, simuliraj na osnovu cijena_stara
        if (historija.length === 0) {
            const sad = new Date();
            if (o.cijena_stara && o.datum_pada_cijene) {
                historija = [
                    { cijena_num: parseFloat(o.cijena_stara), datum: o.datum },
                    { cijena_num: parseFloat(o.cijena_num), datum: o.datum_pada_cijene }
                ];
            } else {
                historija = [{ cijena_num: parseFloat(o.cijena_num), datum: o.datum }];
            }
        }

        // Uzmi prosjek kategorije za kontekst
        let avgKat = null;
        if (o.kategorija) {
            const avg = await pool.query(
                'SELECT AVG(cijena_num) as avg FROM live_oglasi WHERE kategorija = $1 AND cijena_num > 0 AND cijena_num < 500000',
                [o.kategorija]
            );
            avgKat = avg.rows[0]?.avg ? Math.round(parseFloat(avg.rows[0].avg)) : null;
        }

        const danaNaTrzistu = Math.floor((new Date() - new Date(o.datum)) / (1000 * 60 * 60 * 24));

        res.json({ uspjeh: true, historija, avgKat, danaNaTrzistu, cijenaTrenutna: parseFloat(o.cijena_num), cijena: o.cijena });
    } catch(e) {
        res.json({ uspjeh: false, poruka: e.message });
    }
});

// ── JOBS AGREGACIJA (MojPosao) ───────────────────────────
app.get('/api/jobs', async (req, res) => {
    try {
        const q = req.query.q || '';
        const grad = req.query.grad || '';
        // MojPosao RSS feed - javno dostupan
        const https = require('https');
        const rssUrl = 'https://www.mojposao.ba/rss/jobs' + (q ? '?keywords=' + encodeURIComponent(q) : '');

        const rssData = await new Promise((resolve, reject) => {
            https.get(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
                let d = '';
                r.on('data', c => d += c);
                r.on('end', () => resolve(d));
            }).on('error', reject);
        });

        // Parse RSS
        const items = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        while ((match = itemRegex.exec(rssData)) !== null && items.length < 20) {
            const item = match[1];
            const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1] || '';
            const link = (item.match(/<link>(.*?)<\/link>/))?.[1] || '';
            const desc = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/))?.[1] || '';
            const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/))?.[1] || '';
            if (title && link) {
                const descClean = desc.replace(/<[^>]*>/g, '').substring(0, 150);
                items.push({ naslov: title, link, opis: descClean, datum: pubDate, platforma: 'mojposao', tip: 'posao' });
            }
        }

        // Ako RSS ne radi, vrati mock podatke
        if (items.length === 0) {
            const mockJobs = [
                { naslov: 'Web Developer (React/Node.js)', link: 'https://www.mojposao.ba', opis: 'Trazimo iskusnog web developera za rad na SaaS platformi. Rad od kuce moguc.', grad: 'Sarajevo', plata: '2.500 - 4.000 KM', datum: new Date().toISOString(), platforma: 'mojposao', tip: 'posao' },
                { naslov: 'Vozac C/E kategorije', link: 'https://www.mojposao.ba', opis: 'Potreban vozac za medjunarodne relacije. Iskustvo minimum 2 godine.', grad: 'Tuzla', plata: '2.000 - 3.000 KM', datum: new Date().toISOString(), platforma: 'mojposao', tip: 'posao' },
                { naslov: 'Konobar/ica — sezona 2025', link: 'https://www.mojposao.ba', opis: 'Ugostitelsjki objekat u centru trazi konobare za ljetnu sezonu.', grad: 'Mostar', plata: '900 - 1.200 KM', datum: new Date().toISOString(), platforma: 'mojposao', tip: 'posao' },
                { naslov: 'Racunovodja — certifikovani', link: 'https://www.mojposao.ba', opis: 'Potrebna osoba sa iskustvom u PDV prijavi i finansijskim izvjestajima.', grad: 'Banja Luka', plata: '1.800 - 2.500 KM', datum: new Date().toISOString(), platforma: 'mojposao', tip: 'posao' },
                { naslov: 'Prodavac/ica u maloprodaji', link: 'https://www.mojposao.ba', opis: 'Lancani maloprodajni objekat prima radnike za rad u smjenama.', grad: 'Zenica', plata: '900 - 1.100 KM', datum: new Date().toISOString(), platforma: 'mojposao', tip: 'posao' },
                { naslov: 'Graficki dizajner — freelance', link: 'https://www.mojposao.ba', opis: 'Agencija trazi dizajnera za projektnu saradnju. Adobe CC obavezan.', grad: 'Sarajevo', plata: 'Po dogovoru', datum: new Date().toISOString(), platforma: 'mojposao', tip: 'posao' },
            ];
            return res.json({ uspjeh: true, jobs: mockJobs, izvor: 'demo' });
        }

        res.json({ uspjeh: true, jobs: items, izvor: 'mojposao' });
    } catch(e) {
        res.json({ uspjeh: false, poruka: e.message });
    }
});

// ── KONKURENTI — INICIJALIZACIJA TABELA ──────────────────
async function initKonkurenti() {
    await pool.query(`CREATE TABLE IF NOT EXISTS konkurenti (
        id SERIAL PRIMARY KEY,
        korisnik_email VARCHAR(100) NOT NULL,
        olx_username VARCHAR(100) NOT NULL,
        naziv VARCHAR(200),
        user_id INTEGER,
        user_type VARCHAR(50),
        grad VARCHAR(100),
        slika TEXT,
        ukupno_oglasa INTEGER DEFAULT 0,
        prosjecna_cijena NUMERIC,
        datum_dodavanja TIMESTAMP DEFAULT NOW(),
        zadnji_fetch TIMESTAMP,
        UNIQUE(korisnik_email, olx_username)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS konkurent_oglasi (
        id SERIAL PRIMARY KEY,
        konkurent_id INTEGER REFERENCES konkurenti(id) ON DELETE CASCADE,
        olx_id INTEGER UNIQUE,
        naslov TEXT,
        cijena TEXT,
        cijena_num NUMERIC,
        slika TEXT,
        link TEXT,
        kategorija_id INTEGER,
        status VARCHAR(50) DEFAULT 'active',
        datum_objave TIMESTAMP,
        datum_prodaje TIMESTAMP,
        datum_fetch TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS konkurent_cijena_historija (
        id SERIAL PRIMARY KEY,
        olx_id INTEGER,
        cijena_num NUMERIC,
        datum TIMESTAMP DEFAULT NOW()
    )`);
}
initKonkurenti().catch(e => console.log('Konkurenti init greska:', e.message));

// ── DODAJ KONKURENTA ─────────────────────────────────────
app.post('/api/konkurent-dodaj', async (req, res) => {
    try {
        const { korisnik_email, olx_username } = req.body;
        if (!korisnik_email || !olx_username) return res.json({ uspjeh: false, poruka: 'Nedostaju podaci' });

        const username = olx_username.trim().toLowerCase().replace(/^@/, '');

        // Dohvati profil sa OLX API-ja
        const olxRes = await fetch2(`https://api.olx.ba/users/${username}/listings?page=1`, {
            headers: {
                'Authorization': `Bearer ${process.env.OLX_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (!olxRes.ok) return res.json({ uspjeh: false, poruka: 'Korisnik nije pronađen na OLX.ba. Provjeri username.' });

        const olxData = await olxRes.json();
        const oglasi = olxData.data || [];
        const meta = olxData.meta || {};
        const prviOglas = oglasi[0] || {};

        const userId = prviOglas.user_id || null;
        const userType = prviOglas.user_type || 'private';
        const ukupno = meta.total || oglasi.length;

        // Prosjecna cijena
        const cijene = oglasi.map(o => o.price).filter(p => p > 100 && p < 500000);
        const prosjek = cijene.length ? Math.round(cijene.reduce((a,b) => a+b, 0) / cijene.length) : null;

        // Spremi u bazu
        const result = await pool.query(
            `INSERT INTO konkurenti (korisnik_email, olx_username, naziv, user_id, user_type, ukupno_oglasa, prosjecna_cijena, zadnji_fetch)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
             ON CONFLICT (korisnik_email, olx_username) DO UPDATE SET
             naziv = $3, ukupno_oglasa = $6, prosjecna_cijena = $7, zadnji_fetch = NOW()
             RETURNING id`,
            [korisnik_email, username, username, userId, userType, ukupno, prosjek]
        );

        const konkurentId = result.rows[0].id;

        // Spremi prve oglase
        for (const o of oglasi.slice(0, 50)) {
            const cijenaNum = o.price || 0;
            const link = `https://www.olx.ba/artikal/${o.id}`;
            // OLX image: moze biti null, filename ili URL
            let slika = null;
            if (o.image) {
                if (o.image.startsWith('http')) slika = o.image;
                else slika = `https://d4n0y8dshd77z.cloudfront.net/listings/${o.id}/sm/${o.image}`;
            } else if (o.thumbnail) {
                slika = o.thumbnail.startsWith('http') ? o.thumbnail : `https://d4n0y8dshd77z.cloudfront.net/listings/${o.id}/sm/${o.thumbnail}`;
            }
            // Fallback - probaj direktni oglas API za sliku
            if (!slika) {
                try {
                    const detRes = await fetch2(`https://api.olx.ba/listings/${o.id}`, {
                        headers: { 'Authorization': `Bearer ${process.env.OLX_TOKEN}`, 'Content-Type': 'application/json' }
                    });
                    if (detRes.ok) {
                        const det = await detRes.json();
                        const imgs = det.images || det.gallery || [];
                        if (imgs.length) slika = imgs[0].url || imgs[0].thumb || imgs[0];
                    }
                } catch(e) {}
            }
            const datumObjave = o.date ? new Date(o.date * 1000) : new Date();

            await pool.query(
                `INSERT INTO konkurent_oglasi (konkurent_id, olx_id, naslov, cijena, cijena_num, slika, link, kategorija_id, status, datum_objave)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)
                 ON CONFLICT (olx_id) DO UPDATE SET cijena = $4, cijena_num = $5, status = 'active', slika = COALESCE($6, konkurent_oglasi.slika)`,
                [konkurentId, o.id, o.title, o.display_price, cijenaNum, slika, link, o.category_id, datumObjave]
            );

            // Historija cijene
            await pool.query(
                `INSERT INTO konkurent_cijena_historija (olx_id, cijena_num) VALUES ($1, $2)`,
                [o.id, cijenaNum]
            ).catch(() => {});
        }

        res.json({
            uspjeh: true,
            poruka: `Konkurent ${username} dodan! Praćenje ${ukupno} oglasa.`,
            konkurent: { id: konkurentId, username, userType, ukupno, prosjek }
        });
    } catch(e) {
        res.json({ uspjeh: false, poruka: 'Greška: ' + e.message });
    }
});

// ── LISTA KONKURENATA ────────────────────────────────────
app.get('/api/konkurenti', async (req, res) => {
    try {
        const { email } = req.query;
        if (!email) return res.json({ uspjeh: false });
        const result = await pool.query(
            'SELECT * FROM konkurenti WHERE korisnik_email = $1 ORDER BY datum_dodavanja DESC',
            [email]
        );
        res.json({ uspjeh: true, konkurenti: result.rows });
    } catch(e) {
        res.json({ uspjeh: false, poruka: e.message });
    }
});

// ── OGLASI KONKURENTA ────────────────────────────────────
app.get('/api/konkurent-oglasi/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.query;
        let where = 'WHERE konkurent_id = $1';
        const params = [id];
        if (status) { where += ' AND status = $2'; params.push(status); }

        const oglasi = await pool.query(
            `SELECT * FROM konkurent_oglasi ${where} ORDER BY datum_objave DESC LIMIT 100`,
            params
        );
        const historija = await pool.query(
            `SELECT h.olx_id, h.cijena_num, h.datum FROM konkurent_cijena_historija h
             JOIN konkurent_oglasi o ON h.olx_id = o.olx_id
             WHERE o.konkurent_id = $1
             ORDER BY h.datum DESC LIMIT 200`,
            [id]
        );

        // Stats
        const stats = await pool.query(
            `SELECT
                COUNT(*) FILTER (WHERE status='active') as aktivnih,
                COUNT(*) FILTER (WHERE status='finished') as prodanih,
                AVG(cijena_num) FILTER (WHERE status='active' AND cijena_num > 100) as prosjek_aktivnih,
                MIN(datum_objave) as najstariji,
                MAX(datum_objave) as najnoviji
             FROM konkurent_oglasi WHERE konkurent_id = $1`,
            [id]
        );

        res.json({
            uspjeh: true,
            oglasi: oglasi.rows,
            historija: historija.rows,
            stats: stats.rows[0]
        });
    } catch(e) {
        res.json({ uspjeh: false, poruka: e.message });
    }
});

// ── REFRESH KONKURENTA ───────────────────────────────────
app.post('/api/konkurent-refresh/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const konkurent = await pool.query('SELECT * FROM konkurenti WHERE id = $1', [id]);
        if (!konkurent.rows.length) return res.json({ uspjeh: false, poruka: 'Nije pronađen' });

        const k = konkurent.rows[0];
        const username = k.olx_username;

        let stranica = 1, noviOglasi = 0, ukupnoFetchano = 0;
        while (stranica <= 5) {
            const olxRes = await fetch2(`https://api.olx.ba/users/${username}/listings?page=${stranica}`, {
                headers: { 'Authorization': `Bearer ${process.env.OLX_TOKEN}`, 'Content-Type': 'application/json' }
            });
            if (!olxRes.ok) break;
            const olxData = await olxRes.json();
            const oglasi = olxData.data || [];
            if (!oglasi.length) break;

            for (const o of oglasi) {
                const cijenaNum = o.price || 0;
                const link = `https://www.olx.ba/artikal/${o.id}`;
                const slika = o.image ? (o.image.startsWith('http') ? o.image : `https://d4n0y8dshd77z.cloudfront.net/listings/${o.id}/sm/${o.image}`) : null;
                const datumObjave = o.date ? new Date(o.date * 1000) : new Date();

                const existing = await pool.query('SELECT cijena_num FROM konkurent_oglasi WHERE olx_id = $1', [o.id]);
                if (existing.rows.length) {
                    const staraCijena = parseFloat(existing.rows[0].cijena_num);
                    if (Math.abs(staraCijena - cijenaNum) > 50) {
                        // Cijena se promijenila — zabilježi
                        await pool.query(
                            'INSERT INTO konkurent_cijena_historija (olx_id, cijena_num) VALUES ($1, $2)',
                            [o.id, cijenaNum]
                        ).catch(() => {});
                    }
                    await pool.query(
                        'UPDATE konkurent_oglasi SET cijena = $1, cijena_num = $2, status = $3 WHERE olx_id = $4',
                        [o.display_price, cijenaNum, 'active', o.id]
                    );
                } else {
                    await pool.query(
                        `INSERT INTO konkurent_oglasi (konkurent_id, olx_id, naslov, cijena, cijena_num, slika, link, kategorija_id, status, datum_objave)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9)`,
                        [id, o.id, o.title, o.display_price, cijenaNum, slika, link, o.category_id, datumObjave]
                    );
                    noviOglasi++;
                    // Historija
                    await pool.query('INSERT INTO konkurent_cijena_historija (olx_id, cijena_num) VALUES ($1,$2)', [o.id, cijenaNum]).catch(() => {});
                }
                ukupnoFetchano++;
            }

            if (stranica >= (olxData.meta?.last_page || 1)) break;
            stranica++;
            await new Promise(r => setTimeout(r, 300));
        }

        // Ažuriraj stats
        const prosjekRes = await pool.query(
            'SELECT AVG(cijena_num) as prosjek, COUNT(*) as ukupno FROM konkurent_oglasi WHERE konkurent_id = $1 AND status = $2 AND cijena_num > 100',
            [id, 'active']
        );
        await pool.query(
            'UPDATE konkurenti SET zadnji_fetch = NOW(), ukupno_oglasa = $1, prosjecna_cijena = $2 WHERE id = $3',
            [prosjekRes.rows[0].ukupno, prosjekRes.rows[0].prosjek, id]
        );

        res.json({ uspjeh: true, noviOglasi, ukupnoFetchano });
    } catch(e) {
        res.json({ uspjeh: false, poruka: e.message });
    }
});

// ── UKLONI KONKURENTA ────────────────────────────────────
app.delete('/api/konkurent/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM konkurenti WHERE id = $1', [req.params.id]);
        res.json({ uspjeh: true });
    } catch(e) {
        res.json({ uspjeh: false });
    }
});


// ════════════════════════════════════════════════════════
// OGLIX INTELLIGENCE — 3 KILLER FEATUREA
// ════════════════════════════════════════════════════════

// ── 1. SLABOSTI KONKURENTA — AI analiza ──────────────────
app.post('/api/konkurent-slabosti', async (req, res) => {
    try {
        const { konkurent_id } = req.body;
        const konkurent = await pool.query('SELECT * FROM konkurenti WHERE id = $1', [konkurent_id]);
        if (!konkurent.rows.length) return res.json({ uspjeh: false });
        const k = konkurent.rows[0];

        // Dohvati sve aktivne oglase
        const oglasi = await pool.query(
            `SELECT *, EXTRACT(DAY FROM NOW() - datum_objave) as dana_na_trzistu
             FROM konkurent_oglasi WHERE konkurent_id = $1 AND status = 'active' AND cijena_num > 0
             ORDER BY dana_na_trzistu DESC`,
            [konkurent_id]
        );

        // Precizan prosjek po modelu iz naslova za svaki oglas
        // Globalni prosjek kao fallback
        const trzisniProsjek = await pool.query(
            `SELECT AVG(cijena_num) as avg FROM live_oglasi WHERE cijena_num > 1000 AND cijena_num < 500000 AND platforma = 'olx'`
        );
        const avgGlobalni = parseFloat(trzisniProsjek.rows[0]?.avg) || 20000;

        // Dohvat preciznog prosjeka po modelu (vanjska helper funkcija)
        // Izracunaj prosjek za svaki oglas posebno
        const oglasiData = oglasi.rows;
        const oglasiSaProsjekom = await Promise.all(oglasiData.map(async (o) => {
            const modelInfo = await getModelProsjekZaOglas(pool, o, avgGlobalni);
            return {
                id: o.id, naslov: o.naslov, cijena: o.cijena, cijena_num: o.cijena_num,
                slika: o.slika, link: o.link, dana_na_trzistu: o.dana_na_trzistu,
                modelAvg: modelInfo.avg,
                modelBroj: modelInfo.broj,
                modelMin: modelInfo.min,
                modelMax: modelInfo.max,
                gorivo: modelInfo.gorivo,
                transmisija: modelInfo.transmisija
            };
        }));

        const avgTrziste = avgGlobalni;

        // Prodana vozila
        const prodana = await pool.query(
            `SELECT COUNT(*) as broj, AVG(EXTRACT(DAY FROM datum_prodaje - datum_objave)) as avg_dana
             FROM konkurent_oglasi WHERE konkurent_id = $1 AND status = 'finished'`,
            [konkurent_id]
        );

        const dugoCekaju = oglasiSaProsjekom.filter(o => parseFloat(o.dana_na_trzistu) > 30);
        // Previsoko - poredi sa prosjekom TOG MODELA, ne globalnim
        const previsoko = oglasiSaProsjekom.filter(o => o.modelAvg > 0 && o.cijena_num > o.modelAvg * 1.12);

        // Izgradnja AI prompta
        const dugoCekaListaTxt = dugoCekaju.slice(0, 5).map(function(o) { return '- ' + o.naslov + ': ' + o.cijena + ' (' + Math.round(o.dana_na_trzistu) + ' dana)'; }).join('\n');
        const preVisListaTxt = previsoko.slice(0, 5).map(function(o) { return '- ' + o.naslov + ': ' + o.cijena; }).join('\n');
        const prompt = 'Ti si ekspert za automobilsko tržište u Bosni i Hercegovini. Analiziraj konkurenta i pronađi njihove slabosti.\n\n' +
            'Konkurent: ' + k.olx_username + '\n' +
            'Tip: ' + (k.user_type === 'shop' ? 'Salon' : 'Privatni') + '\n' +
            'Ukupno aktivnih oglasa: ' + oglasiData.length + '\n' +
            'Prosječna cijena: ' + (k.prosjecna_cijena ? Math.round(k.prosjecna_cijena).toLocaleString() + ' KM' : 'N/A') + '\n' +
            'Tržišni prosjek: ' + Math.round(avgTrziste).toLocaleString() + ' KM\n\n' +
            'Oglasi koji stoje dugo (30+ dana): ' + dugoCekaju.length + ' vozila\n' + dugoCekaListaTxt + '\n\n' +
            'Oglasi iznad tržišnog prosjeka: ' + previsoko.length + ' vozila\n' + preVisListaTxt + '\n\n' +
            'Prodana vozila: ' + (prodana.rows[0]?.broj || 0) + '\n' +
            'Prosječno dana do prodaje: ' + (prodana.rows[0]?.avg_dana ? Math.round(prodana.rows[0].avg_dana) : 'N/A') + '\n\n' +
            'Na osnovu ovih podataka, daj mi:\n' +
            '1. SLABOSTI: 3 konkretne slabosti ovog konkurenta (kratko, direktno)\n' +
            '2. PRILIKE: 3 konkretne tržišne prilike koje mogu iskoristiti dileri\n' +
            '3. PREPORUKA: 1 konkretna akcija koju diler treba odmah poduzeti\n\n' +
            'Odgovori kratko i konkretno. Svaka stavka max 2 rečenice.'

        const analiza = await groqAI(prompt, 600);

        // Formatiraj output
        const slabosti = {
            dugoCekaju: dugoCekaju.slice(0, 5).map(o => ({
                naslov: o.naslov,
                cijena: o.cijena,
                dana: Math.round(parseFloat(o.dana_na_trzistu)),
                link: o.link
            })),
            previsoko: previsoko.slice(0, 5).map(o => ({
                naslov: o.naslov,
                cijena: o.cijena,
                cijenaNum: parseFloat(o.cijena_num),
                modelAvg: Math.round(o.modelAvg),
                modelBroj: o.modelBroj || 0,
                modelMin: Math.round(o.modelMin || 0),
                modelMax: Math.round(o.modelMax || 0),
                gorivo: o.gorivo,
                transmisija: o.transmisija,
                visokoZa: o.modelAvg > 0 ? Math.round((parseFloat(o.cijena_num) - o.modelAvg) / o.modelAvg * 100) : 0,
                link: o.link
            })),
            ukupnoAktivnih: oglasiData.length,
            ukupnoDugo: dugoCekaju.length,
            ukupnoPrevisoko: previsoko.length,
            avgDanaDoProdaje: prodana.rows[0]?.avg_dana ? Math.round(prodana.rows[0].avg_dana) : null,
            aiAnaliza: analiza
        };

        res.json({ uspjeh: true, slabosti });
    } catch(e) {
        res.json({ uspjeh: false, poruka: e.message });
    }
});

// ── 2. OGLIX PREDICT™ — predviđanje pada cijene ──────────
app.get('/api/predict/:konkurent_id', async (req, res) => {
    try {
        const { konkurent_id } = req.params;
        const oglasi = await pool.query(
            `SELECT o.*,
                EXTRACT(DAY FROM NOW() - o.datum_objave) as dana_na_trzistu,
                (SELECT COUNT(*) FROM konkurent_cijena_historija h WHERE h.olx_id = o.olx_id) as broj_promjena,
                (SELECT MIN(h.cijena_num) FROM konkurent_cijena_historija h WHERE h.olx_id = o.olx_id) as min_cijena,
                (SELECT MAX(h.cijena_num) FROM konkurent_cijena_historija h WHERE h.olx_id = o.olx_id) as max_cijena
             FROM konkurent_oglasi o
             WHERE o.konkurent_id = $1 AND o.status = 'active' AND o.cijena_num > 1000
             ORDER BY dana_na_trzistu DESC`,
            [konkurent_id]
        );

        // Za svaki oglas dohvati prosjek specificnog modela
        const globalAvgRes = await pool.query(
            `SELECT AVG(cijena_num) as avg FROM live_oglasi WHERE cijena_num > 1000 AND cijena_num < 500000`
        );
        const globalAvg = parseFloat(globalAvgRes.rows[0]?.avg) || 20000;

        // Model prosjek helper (vanjska funkcija getModelProsjekHelper)
        // Obogati oglase sa model prosjekom
        const oglasiObogaceni = await Promise.all(oglasi.rows.map(async (o) => {
            const modelInfo = await getModelProsjekZaOglas(pool, o, globalAvg);
            return {
                olx_id: o.olx_id, naslov: o.naslov, cijena: o.cijena, cijena_num: o.cijena_num,
                slika: o.slika, link: o.link, dana_na_trzistu: o.dana_na_trzistu,
                broj_promjena: o.broj_promjena, max_cijena: o.max_cijena, min_cijena: o.min_cijena,
                modelAvg: modelInfo.avg,
                modelBroj: modelInfo.broj,
                modelMin: modelInfo.min,
                modelMax: modelInfo.max
            };
        }));

        const avgTrziste = globalAvg;

        // Kraj mjeseca bonus
        const danas = new Date();
        const krajMjeseca = new Date(danas.getFullYear(), danas.getMonth() + 1, 0);
        const danaDoKraja = Math.floor((krajMjeseca - danas) / (1000 * 60 * 60 * 24));
        const krajMjesecaFaktor = danaDoKraja <= 7 ? 15 : 0;

        const predictions = oglasiObogaceni.map(o => {
            const dana = parseFloat(o.dana_na_trzistu) || 0;
            const cijenaNum = parseFloat(o.cijena_num) || 0;
            const maxCijena = parseFloat(o.max_cijena) || cijenaNum;
            const minCijena = parseFloat(o.min_cijena) || cijenaNum;

            // Score faktori (0-100)
            let score = 0;
            let razlozi = [];

            // 1. Dugo na tržištu
            if (dana > 45) { score += 35; razlozi.push('Na tržištu ' + Math.round(dana) + ' dana'); }
            else if (dana > 30) { score += 20; razlozi.push('Na tržištu ' + Math.round(dana) + ' dana'); }
            else if (dana > 15) { score += 8; }

            // 2. Cijena iznad prosjeka MODELA (ne globalnog!)
            const modelAvg = parseFloat(o.modelAvg) || avgTrziste;
            const odnosProsjeka = modelAvg > 0 ? cijenaNum / modelAvg : 1;
            if (odnosProsjeka > 1.20) { score += 30; razlozi.push('Cijena ' + Math.round((odnosProsjeka-1)*100) + '% iznad prosjeka'); }
            else if (odnosProsjeka > 1.10) { score += 15; razlozi.push('Cijena ' + Math.round((odnosProsjeka-1)*100) + '% iznad prosjeka'); }

            // 3. Prethodne promjene cijene
            if (parseInt(o.broj_promjena) > 1) { score += 20; razlozi.push('Cijena već mijenjana ' + o.broj_promjena + 'x'); }

            // 4. Kraj mjeseca
            if (krajMjesecaFaktor > 0) { score += krajMjesecaFaktor; razlozi.push('Kraj mjeseca — saloni imaju targete'); }

            // 5. Pad od max cijene
            if (maxCijena > cijenaNum + 500) {
                score += 15;
                razlozi.push('Već sniženo za ' + Math.round(maxCijena - cijenaNum).toLocaleString('bs-BA') + ' KM');
            }

            score = Math.min(score, 99);

            // Procjena iznosa sniženja
            const procijenjeniPad = cijenaNum > 50000 ? Math.round(cijenaNum * 0.07) :
                cijenaNum > 20000 ? Math.round(cijenaNum * 0.08) :
                Math.round(cijenaNum * 0.10);

            return {
                olx_id: o.olx_id,
                naslov: o.naslov,
                cijena: o.cijena,
                cijenaNum,
                slika: o.slika,
                link: o.link,
                dana: Math.round(dana),
                score,
                razlozi,
                procijenjeniPad,
                novaCijena: cijenaNum - procijenjeniPad,
                vjerojatnost: score >= 70 ? 'Visoka' : score >= 40 ? 'Srednja' : 'Niska'
            };
        }).filter(p => p.score >= 20).sort((a, b) => b.score - a.score);

        res.json({ uspjeh: true, predictions, danaDoKrajaMjeseca: danaDoKraja });
    } catch(e) {
        res.json({ uspjeh: false, poruka: e.message });
    }
});

// ── 3. OGLIX IMPORT INTEL™ — uvozne prilike ──────────────
async function initImport() {
    await pool.query(`CREATE TABLE IF NOT EXISTS import_prilike (
        id SERIAL PRIMARY KEY,
        izvor VARCHAR(50),
        ext_id VARCHAR(100),
        naslov TEXT,
        cijena_eur NUMERIC,
        cijena_import_km NUMERIC,
        cijena_trziste_km NUMERIC,
        zarada_km NUMERIC,
        slika TEXT,
        link TEXT,
        godiste INTEGER,
        km INTEGER,
        gorivo VARCHAR(50),
        grad VARCHAR(100),
        zemlja VARCHAR(50),
        datum_fetch TIMESTAMP DEFAULT NOW(),
        UNIQUE(izvor, ext_id)
    )`);
}
initImport().catch(e => console.log('Import init:', e.message));


// ── DOHVATI SLIKU OGLASA ─────────────────────────────────
app.get('/api/oglas-slika/:olx_id', async (req, res) => {
    try {
        const { olx_id } = req.params;
        // Provjeri bazu prvo
        const db = await pool.query('SELECT slika FROM konkurent_oglasi WHERE olx_id = $1', [olx_id]);
        if (db.rows[0]?.slika) return res.json({ uspjeh: true, slika: db.rows[0].slika });
        
        // Dohvati sa OLX API
        const olxRes = await fetch2(`https://api.olx.ba/listings/${olx_id}`, {
            headers: { 'Authorization': `Bearer ${process.env.OLX_TOKEN}`, 'Content-Type': 'application/json' }
        });
        if (!olxRes.ok) return res.json({ uspjeh: false });
        const det = await olxRes.json();
        
        let slika = null;
        // OLX vraca razlicite formate
        if (det.images && det.images.length) {
            slika = det.images[0]?.url || det.images[0]?.thumb || det.images[0];
        } else if (det.image) {
            slika = det.image.startsWith('http') ? det.image : 
                    `https://d4n0y8dshd77z.cloudfront.net/listings/${olx_id}/sm/${det.image}`;
        } else if (det.gallery && det.gallery.length) {
            slika = det.gallery[0]?.url || det.gallery[0];
        }
        
        if (slika) {
            // Spremi u bazu za sljedeći put
            await pool.query('UPDATE konkurent_oglasi SET slika = $1 WHERE olx_id = $2', [slika, olx_id]);
        }
        
        res.json({ uspjeh: !!slika, slika });
    } catch(e) {
        res.json({ uspjeh: false });
    }
});

// Import Intel koristi staticki model iz /api/import-prilike

app.get('/api/import-prilike', async (req, res) => {
    try {
        // Dohvati prosjecne cijene po modelima iz nase baze za kalkulaciju
        const modeli = [
            { kljuc: 'golf', naziv: 'VW Golf', kw_od: 85, cijena_eur: 11500, godiste: 2016, km: 120000, zemlja: 'Njemačka', gorivo: 'Dizel' },
            { kljuc: 'passat', naziv: 'VW Passat', kw_od: 110, cijena_eur: 14000, godiste: 2017, km: 150000, zemlja: 'Austrija', gorivo: 'Dizel' },
            { kljuc: 'bmw+x5', naziv: 'BMW X5', kw_od: 140, cijena_eur: 28000, godiste: 2016, km: 160000, zemlja: 'Njemačka', gorivo: 'Dizel' },
            { kljuc: 'mercedes+gle', naziv: 'Mercedes GLE', kw_od: 150, cijena_eur: 32000, godiste: 2017, km: 140000, zemlja: 'Slovenija', gorivo: 'Dizel' },
            { kljuc: 'audi+a6', naziv: 'Audi A6', kw_od: 130, cijena_eur: 18000, godiste: 2016, km: 130000, zemlja: 'Austrija', gorivo: 'Dizel' },
            { kljuc: 'tiguan', naziv: 'VW Tiguan', kw_od: 110, cijena_eur: 16000, godiste: 2017, km: 110000, zemlja: 'Njemačka', gorivo: 'Dizel' },
            { kljuc: 'skoda+octavia', naziv: 'Škoda Octavia', kw_od: 85, cijena_eur: 9500, godiste: 2016, km: 140000, zemlja: 'Češka', gorivo: 'Dizel' },
            { kljuc: 'ford+focus', naziv: 'Ford Focus', kw_od: 70, cijena_eur: 8500, godiste: 2016, km: 130000, zemlja: 'Austrija', gorivo: 'Dizel' },
        ];

        const TECAJ = 1.956;
        const CARINA = 0.065;
        const PDV = 0.17;

        const prilike = await Promise.all(modeli.map(async (m) => {
            // Dohvati realni tržišni prosjek iz naše baze
            const trziste = await pool.query(
                `SELECT AVG(cijena_num) as avg, COUNT(*) as broj FROM live_oglasi
                 WHERE kategorija LIKE 'vozila%' AND cijena_num > 3000 AND cijena_num < 200000
                 AND naslov ILIKE $1`,
                ['%' + m.naziv.split(' ').pop() + '%']
            );
            const avgBiH = parseFloat(trziste.rows[0]?.avg) || 0;
            const brojOglasa = parseInt(trziste.rows[0]?.broj) || 0;

            if (!avgBiH) return null;

            // Kalkulacija uvoza
            const cijenaKM = m.cijena_eur * TECAJ;
            const carina = cijenaKM * CARINA;
            const pdv = (cijenaKM + carina) * PDV;
            const transport = m.zemlja === 'Slovenija' ? 400 : m.zemlja === 'Austrija' ? 550 : 800;
            const ukupnoKostanje = Math.round(cijenaKM + carina + pdv + transport);
            const zaradaPotencijal = Math.round(avgBiH - ukupnoKostanje);
            const zaradaPosto = avgBiH > 0 ? Math.round((zaradaPotencijal / ukupnoKostanje) * 100) : 0;

            return {
                naziv: m.naziv,
                zemlja: m.zemlja,
                godiste: m.godiste,
                km: m.km,
                gorivo: m.gorivo,
                cijenaEur: m.cijena_eur,
                cijenaKM: Math.round(cijenaKM),
                carina: Math.round(carina),
                pdv: Math.round(pdv),
                transport,
                ukupnoKostanje,
                avgBiH: Math.round(avgBiH),
                zaradaPotencijal,
                zaradaPosto,
                brojOglasaBiH: brojOglasa,
                autoscout24Link: `https://www.autoscout24.de/lst?sort=standard&desc=0&ustate=N%2CU&size=20&atype=C&search_id=1&mmvmk0=${m.kljuc}&priceto=${m.cijena_eur + 2000}&fregfrom=${m.godiste - 1}&fregto=${m.godiste + 2}`,
                mobileDe: `https://suchen.mobile.de/fahrzeuge/search.html?isSearchRequest=true&makeModelVariant1.makeId=1900&makeModelVariant1.modelDescription=${m.kljuc}&maxPrice=${m.cijena_eur + 2000}&minFirstRegistrationDate=${m.godiste - 1}-01-01`,
                isplativo: zaradaPotencijal > 2000
            };
        }));

        const filtrirano = prilike.filter(p => p && p.isplativo).sort((a, b) => b.zaradaPotencijal - a.zaradaPotencijal);

        res.json({ uspjeh: true, prilike: filtrirano, tecaj: TECAJ });
    } catch(e) {
        res.json({ uspjeh: false, poruka: e.message });
    }
});

fetchSveKategorije();
setInterval(fetchSveKategorije, 2 * 60 * 60 * 1000);

app.listen(PORT, () => console.log(`Server radi na portu ${PORT}`));