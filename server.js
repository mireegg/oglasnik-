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

async function initDB() {
    await pool.query(`CREATE TABLE IF NOT EXISTS korisnici (id SERIAL PRIMARY KEY, ime VARCHAR(100), email VARCHAR(100) UNIQUE, lozinka VARCHAR(100), datum TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS prijave (id SERIAL PRIMARY KEY, ime VARCHAR(100), email VARCHAR(100), telefon VARCHAR(50), datum TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pracenja (id SERIAL PRIMARY KEY, korisnik_email VARCHAR(100), pretraga VARCHAR(200), aktivno BOOLEAN DEFAULT true, datum TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS live_oglasi (id SERIAL PRIMARY KEY, naslov TEXT, cijena TEXT, slika TEXT, link TEXT UNIQUE, platforma VARCHAR(50) DEFAULT 'olx', kategorija VARCHAR(100), datum TIMESTAMP DEFAULT NOW())`);
    await pool.query(`ALTER TABLE pracenja ADD COLUMN IF NOT EXISTS link TEXT`);
    await pool.query(`ALTER TABLE pracenja ADD COLUMN IF NOT EXISTS slika TEXT`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS kategorija VARCHAR(100)`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS brand_id INTEGER`);
    console.log('Baza inicijalizovana!');
}
initDB();

// ── STATIC ──────────────────────────────────────────────
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

    const body = JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 1500 });
    const options = {
        hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Length': Buffer.byteLength(body) }
    };
    const apiReq = https.request(options, apiRes => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
            try { res.json({ uspjeh: true, analiza: JSON.parse(data).choices[0].message.content }); }
            catch(e) { res.json({ uspjeh: false, poruka: 'Greška pri analizi' }); }
        });
    });
    apiReq.on('error', e => res.json({ uspjeh: false, poruka: e.message }));
    apiReq.write(body); apiReq.end();
});

// ── AI ANALIZA JEDNOG OGLASA ──────────────────────────────
app.post('/api/analiza-jednog-oglasa', async (req, res) => {
    const { oglas, slicni } = req.body;
    const d = oglas.detalji || {};
    const prompt = `Ti si iskusan savjetnik za kupovinu vozila u Bosni i Hercegovini.

Oglas koji analiziraš:
- Naziv: ${oglas.naslov}
- Cijena: ${oglas.cijenaStr}
- Brand/Model: ${d.brand || ''} ${d.model || ''}
- Godište: ${d.godiste || 'nepoznato'}
- Gorivo: ${d.gorivo || 'nepoznato'}
- Transmisija: ${d.transmisija || 'nepoznato'}
- Kilometraža: ${d.km ? Number(d.km).toLocaleString() + ' km' : 'nepoznato'}
- Kubikaža: ${d.kubikaza || 'nepoznato'}
- Snaga: ${d.kw ? d.kw + ' kW' : 'nepoznato'}
- Boja: ${d.boja || 'nepoznato'}

Slični oglasi na tržištu:
${slicni && slicni.length > 0 ? slicni.slice(0,5).map((s, i) => `${i+1}. ${s.naslov} — ${s.cijena}`).join('\n') : 'Nema sličnih oglasa za poređenje'}

Daj analizu u TAČNO ovom formatu:
OCJENA: [ODLIČNO/FER/PREVISOKO/IZBJEGAVAJ]
CIJENA: [Konkretno poređenje sa sličnim oglasima]
SAVJET: [Direktna preporuka]
SCORE: [broj 0-100]`;

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 300, temperature: 0.7 })
        });
        const data = await response.json();
        const tekst = data.choices[0].message.content;
        const scoreMatch = tekst.match(/SCORE:\s*(\d+)/);
        res.json({ uspjeh: true, analiza: tekst, score: scoreMatch ? parseInt(scoreMatch[1]) : 70 });
    } catch(e) { res.json({ uspjeh: false, analiza: 'Analiza nije dostupna.', score: 70 }); }
});

// ── LIVE OGLASI ───────────────────────────────────────────
app.post('/api/sacuvaj-oglase', async (req, res) => {
    const { oglasi } = req.body;
    if (!oglasi || !oglasi.length) return res.json({ uspjeh: false });
    try {
        for (const o of oglasi) {
            await pool.query(
                `INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (link) DO UPDATE SET kategorija = $6`,
                [o.naslov, o.cijena, o.slika, o.link, o.platforma, o.kategorija || null]
            );
        }
        res.json({ uspjeh: true, sacuvano: oglasi.length });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});

app.get('/api/live-oglasi', async (req, res) => {
    try {
        const { q, kategorija } = req.query;
        const offset = parseInt(req.query.offset) || 0;
        const limit = parseInt(req.query.limit) || 48;

        let uvjeti = [], params = [], i = 1;
        if (q) { uvjeti.push(`naslov ILIKE $${i++}`); params.push(`%${q}%`); }
        if (kategorija) {
            const kats = kategorija.split(',').map(k => k.trim());
            uvjeti.push(`kategorija IN (${kats.map(() => `$${i++}`).join(',')})`);
            params.push(...kats);
        }

        const where = uvjeti.length ? 'WHERE ' + uvjeti.join(' AND ') : '';
        const countResult = await pool.query(`SELECT COUNT(*) FROM live_oglasi ${where}`, params);
        const ukupno = parseInt(countResult.rows[0].count);

        params.push(limit, offset);
        const result = await pool.query(
            `SELECT * FROM live_oglasi ${where} ORDER BY datum DESC LIMIT $${i++} OFFSET $${i++}`,
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

// ── OLX DETALJI OGLASA ────────────────────────────────────
app.get('/api/oglas-detalji/:id', async (req, res) => {
    try {
        const response = await axios.get(`https://olx.ba/api/listings/${req.params.id}`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
            timeout: 10000
        });
        const data = response.data;
        const attrs = {};
        (data.attributes || []).forEach(a => { attrs[a.attr_code] = a.value; });
        res.json({
            uspjeh: true,
            detalji: {
                id: data.id, naslov: data.title,
                brand: data.brand?.name || '', model: data.model?.name || '',
                brand_id: data.brand?.id || null, model_id: data.model_id || null,
                godiste: attrs['godiste'] || null, gorivo: attrs['gorivo'] || null,
                transmisija: attrs['transmisija'] || null, km: attrs['kilometra-a'] || null,
                kubikaza: attrs['kubikaza'] || null, kw: attrs['kilovata-kw'] || null,
                boja: attrs['boja'] || null, tip: attrs['tip'] || null,
                grad: data.cities?.[0]?.name || 'BiH', slike: data.images || []
            }
        });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});

// ── SLIČNI OGLASI ─────────────────────────────────────────
app.get('/api/slicni-oglasi', async (req, res) => {
    try {
        const { brand_id, model_id, cijena_od, cijena_do, trenutni_id, gorivo, transmisija, kubikaza, boja, km_od, km_do } = req.query;

        let url = `https://olx.ba/api/search?category_id=18&per_page=40`;
        if (brand_id) url += `&brand=${brand_id}&brands=${brand_id}`;
        if (model_id) url += `&models=${model_id}`;
        if (cijena_od) url += `&price_from=${cijena_od}`;
        if (cijena_do) url += `&price_to=${cijena_do}`;

        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
            timeout: 10000
        });

        const kandidati = (response.data.data || []).filter(o => o.id != trenutni_id);

        const detaljiPromises = kandidati.slice(0, 20).map(async (o) => {
            try {
                const det = await axios.get(`https://olx.ba/api/listings/${o.id}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
                    timeout: 8000
                });
                const attrs = {};
                (det.data.attributes || []).forEach(a => { attrs[a.attr_code] = a.value; });
                return {
                    id: o.id, naslov: o.title,
                    cijena: o.display_price || 'Na upit',
                    slika: o.image || '',
                    link: `https://www.olx.ba/artikal/${o.id}`,
                    gorivo: attrs['gorivo'] || '',
                    transmisija: attrs['transmisija'] || '',
                    kubikaza: parseFloat(attrs['kubikaza']) || null,
                    boja: attrs['boja'] || '',
                    km: attrs['kilometra-a'] || null,
                    model_id: det.data.model_id || null
                };
            } catch(e) { return null; }
        });

        const sviDetalji = (await Promise.all(detaljiPromises)).filter(Boolean);

        const rezultat = sviDetalji.filter(o => {
            if (model_id && o.model_id != model_id) return false;
            if (gorivo && o.gorivo.toLowerCase() !== gorivo.toLowerCase()) return false;
            if (transmisija && o.transmisija.toLowerCase() !== transmisija.toLowerCase()) return false;
            if (kubikaza && Math.abs(o.kubikaza - parseFloat(kubikaza)) > 0.1) return false;
            if (boja && o.boja.toLowerCase() !== boja.toLowerCase()) return false;
            if (km_od && km_do && o.km && (parseInt(o.km) < parseInt(km_od) || parseInt(o.km) > parseInt(km_do))) return false;
            return true;
        }).slice(0, 6);

        res.json({ uspjeh: true, oglasi: rezultat });
    } catch(e) { res.json({ uspjeh: false, oglasi: [] }); }
});

// ── FIX KATEGORIJE (samo OLX vozila) ─────────────────────
app.get('/api/fix-kategorije', async (req, res) => {
    const brendovi = [
        { kljuc: ['volkswagen', 'vw ', ' vw', 'golf', 'passat', 'tiguan', 'polo', 'touareg', 'touran', 'sharan', 'caddy'], kat: 'vozila-volkswagen' },
        { kljuc: ['audi'], kat: 'vozila-audi' },
        { kljuc: ['mercedes', ' glc', ' gle', ' gla', ' glb', ' cls', ' amg', ' cla', ' slk', 'sprinter'], kat: 'vozila-mercedes' },
        { kljuc: ['bmw'], kat: 'vozila-bmw' },
        { kljuc: ['opel'], kat: 'vozila-opel' },
        { kljuc: ['peugeot'], kat: 'vozila-peugeot' },
        { kljuc: ['renault'], kat: 'vozila-renault' },
        { kljuc: ['toyota'], kat: 'vozila-toyota' },
        { kljuc: ['honda'], kat: 'vozila-honda' },
        { kljuc: ['ford'], kat: 'vozila-ford' },
        { kljuc: ['skoda', 'škoda'], kat: 'vozila-skoda' },
        { kljuc: ['seat'], kat: 'vozila-seat' },
        { kljuc: ['fiat'], kat: 'vozila-fiat' },
        { kljuc: ['citroen', 'citroën'], kat: 'vozila-citroen' },
        { kljuc: ['hyundai'], kat: 'vozila-hyundai' },
        { kljuc: ['kia'], kat: 'vozila-kia' },
        { kljuc: ['mazda'], kat: 'vozila-mazda' },
        { kljuc: ['nissan'], kat: 'vozila-nissan' },
        { kljuc: ['suzuki'], kat: 'vozila-suzuki' },
        { kljuc: ['volvo'], kat: 'vozila-volvo' },
        { kljuc: ['porsche'], kat: 'vozila-porsche' },
        { kljuc: ['land rover', 'landrover', 'range rover', 'defender', 'discovery'], kat: 'vozila-landrover' },
        { kljuc: ['jeep'], kat: 'vozila-jeep' },
        { kljuc: ['mitsubishi'], kat: 'vozila-mitsubishi' },
        { kljuc: ['subaru'], kat: 'vozila-subaru' },
        { kljuc: ['dacia'], kat: 'vozila-dacia' },
        { kljuc: ['alfa romeo', 'alfa-romeo'], kat: 'vozila-alfaromeo' },
        { kljuc: ['mini cooper', 'mini one', 'mini clubman', 'mini countryman'], kat: 'vozila-mini' },
        { kljuc: ['chevrolet'], kat: 'vozila-chevrolet' },
    ];
    let ukupno = 0;
    for (const b of brendovi) {
        const uvjet = b.kljuc.map(k => `LOWER(naslov) LIKE '%${k.toLowerCase()}%'`).join(' OR ');
        const r = await pool.query(
            `UPDATE live_oglasi SET kategorija = $1 WHERE platforma = 'olx' AND kategorija = 'vozila' AND (${uvjet})`,
            [b.kat]
        );
        ukupno += r.rowCount;
        console.log(`${b.kat}: ${r.rowCount}`);
    }
    res.json({ uspjeh: true, azurirano: ukupno });
});

// ── OLX FETCH PO BRENDOVIMA (VOZILA) ─────────────────────
const OLX_BRENDOVI = [
    7, 11, 20, 30, 39, 46, 56, 64, 65, 69, 71, 77, 89, 90,
    2, 3, 4, 5, 6, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25,
    26, 27, 28, 29, 31, 32, 33, 34, 35, 36, 37, 38, 40, 41, 42, 43, 44, 45, 47,
    48, 49, 50, 51, 52, 53, 54, 55, 57, 58, 59, 60, 61, 62, 63, 66, 67, 68, 70,
    72, 73, 74, 75, 76, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 91, 92, 93
];

async function fetchBrend(brandId) {
    try {
        const prva = await axios.get(`https://olx.ba/api/search?category_id=18&per_page=40&page=1&brand=${brandId}&brands=${brandId}`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
            timeout: 15000
        });
        const lastPage = Math.min(prva.data.meta?.last_page || 1, 50);
        const sveStrane = [prva.data.data || []];

        for (let str = 2; str <= lastPage; str++) {
            try {
                const r = await axios.get(`https://olx.ba/api/search?category_id=18&per_page=40&page=${str}&brand=${brandId}&brands=${brandId}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
                    timeout: 15000
                });
                sveStrane.push(r.data.data || []);
                await new Promise(r => setTimeout(r, 800));
            } catch(e) {
                if (e.response?.status === 429) await new Promise(r => setTimeout(r, 15000));
            }
        }

        let sacuvano = 0;
        for (const stranica of sveStrane) {
            for (const o of stranica) {
                try {
                    const res = await pool.query(
                        `INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija, brand_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (link) DO NOTHING`,
                        [o.title, o.display_price || 'Na upit', o.image || '', `https://www.olx.ba/artikal/${o.id}`, 'olx', 'vozila', o.brand_id || null]
                    );
                    if (res.rowCount > 0) sacuvano++;
                } catch(e) {}
            }
        }
        if (sacuvano > 0) console.log(`Brend ${brandId}: ${sacuvano} novih oglasa`);
    } catch(e) {
        console.log(`Brend ${brandId} greška:`, e.message);
    }
}

// ── OLX FETCH OSTALIH KATEGORIJA ─────────────────────────
async function fetchOLXKategorija(categoryId, kategorija) {
    try {
        const prvaStrana = await axios.get(`https://olx.ba/api/search?category_id=${categoryId}&per_page=40&page=1`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
            timeout: 15000
        });
        const lastPage = Math.min(prvaStrana.data.meta?.last_page || 1, 100);

        for (const o of (prvaStrana.data.data || [])) {
            try {
                await pool.query(
                    `INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (link) DO NOTHING`,
                    [o.title, o.display_price || 'Na upit', o.image || '', `https://www.olx.ba/artikal/${o.id}`, 'olx', kategorija]
                );
            } catch(e) {}
        }

        for (let stranica = 2; stranica <= lastPage; stranica++) {
            try {
                const response = await axios.get(`https://olx.ba/api/search?category_id=${categoryId}&per_page=40&page=${stranica}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
                    timeout: 15000
                });
                const oglasi = response.data.data || [];
                if (!oglasi.length) break;
                for (const o of oglasi) {
                    try {
                        await pool.query(
                            `INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (link) DO NOTHING`,
                            [o.title, o.display_price || 'Na upit', o.image || '', `https://www.olx.ba/artikal/${o.id}`, 'olx', kategorija]
                        );
                    } catch(e) {}
                }
                if (stranica % 50 === 0) console.log(`OLX: ${kategorija} stranica ${stranica}/${lastPage}`);
                await new Promise(r => setTimeout(r, 3000));
            } catch(e) {
                if (e.response?.status === 429) {
                    await new Promise(r => setTimeout(r, 30000));
                    stranica--;
                }
            }
        }
        console.log(`OLX: ${kategorija} ZAVRŠENA`);
    } catch(e) {
        console.log(`OLX greška za ${kategorija}:`, e.message);
    }
}

// ── AUTOBUM FETCH ─────────────────────────────────────────
async function fetchAutobum() {
    const kategorije = [
        { id: 1, naziv: 'vozila' },
        { id: 2, naziv: 'motocikli' },
        { id: 3, naziv: 'teretna' },
    ];

    for (const kat of kategorije) {
        try {
            const fetchStrana = (page) => new Promise((resolve, reject) => {
                const path = `/api/v1/articles?perPage=40&page=${page}&filters=[{"field":"category_id","type":"eq","value":${kat.id}}]&fieldsFilters=[]`;
                const options = {
                    hostname: 'api.autobum.ba',
                    path: path,
                    method: 'GET',
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://autobum.ba/' }
                };
                const req = https.request(options, res => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try { resolve(JSON.parse(data)); }
                        catch(e) { reject(e); }
                    });
                });
                req.on('error', reject);
                req.end();
            });

            const prva = await fetchStrana(1);
            const lastPage = Math.min(prva.last_page || 1, 50);
            console.log(`Autobum: ${kat.naziv} — ${lastPage} stranica`);

            let sacuvano = 0;
            const sveStrane = [prva.data || []];

            for (let str = 2; str <= lastPage; str++) {
                try {
                    const r = await fetchStrana(str);
                    sveStrane.push(r.data || []);
                    await new Promise(r => setTimeout(r, 1000));
                } catch(e) {}
            }

            for (const stranica of sveStrane) {
                for (const o of stranica) {
                    try {
                        const link = `https://autobum.ba/oglas/${o.id}`;
                        const r = await pool.query(
                            `INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (link) DO NOTHING`,
                            [o.title, o.price || 'Na upit', o.image || '', link, 'autobum', kat.naziv]
                        );
                        if (r.rowCount > 0) sacuvano++;
                    } catch(e) {}
                }
            }
            console.log(`Autobum: ${kat.naziv} — ${sacuvano} novih oglasa`);
        } catch(e) {
            console.log(`Autobum greška ${kat.naziv}:`, e.message);
        }
        await new Promise(r => setTimeout(r, 3000));
    }
    console.log('Autobum fetch završen!');
}

// ── GLAVNI FETCH ──────────────────────────────────────────
async function fetchSveKategorije() {
    console.log('Pokrećem fetch...');

    for (const brandId of OLX_BRENDOVI) {
        await fetchBrend(brandId);
        await new Promise(r => setTimeout(r, 1000));
    }

    const ostale = [
        { id: '21', naziv: 'motocikli' },
        { id: '22', naziv: 'bicikli' },
        { id: '426', naziv: 'nautika' },
        { id: '2457', naziv: 'atv-quad' },
        { id: '23', naziv: 'nekretnine-stanovi' },
        { id: '24', naziv: 'nekretnine-kuce' },
        { id: '29', naziv: 'nekretnine-zemljista' },
        { id: '25', naziv: 'nekretnine-poslovni' },
        { id: '31', naziv: 'elektronika-mobiteli' },
        { id: '1495', naziv: 'elektronika-tableti' },
        { id: '2076', naziv: 'elektronika-satovi' },
        { id: '252', naziv: 'elektronika-dijelovi-mobiteli' },
        { id: '34', naziv: 'elektronika-bluetooth' },
        { id: '38', naziv: 'elektronika-desktop' },
        { id: '39', naziv: 'elektronika-laptopi' },
        { id: '42', naziv: 'elektronika-oprema' },
        { id: '75', naziv: 'elektronika-serveri' },
        { id: '46', naziv: 'elektronika-bijela-tehnika' },
        { id: '45', naziv: 'elektronika-tv' },
        { id: '2392', naziv: 'elektronika-zvucnici' },
        { id: '2129', naziv: 'elektronika-vr' },
        { id: '225', naziv: 'masine-alati' },
    ];

    for (const kat of ostale) {
        await fetchOLXKategorija(kat.id, kat.naziv);
        await new Promise(r => setTimeout(r, 2000));
    }

    await fetchAutobum();
    console.log('Fetch završen!');
}

// ── ENDPOINTI ZA MANUALNI POKRETANJE ─────────────────────
app.get('/api/run-autobum', async (req, res) => {
    res.json({ uspjeh: true, poruka: 'Autobum fetch pokrenut!' });
    fetchAutobum();
});

app.get('/api/test-autobum', async (req, res) => {
    try {
        const url = `https://api.autobum.ba/api/v1/articles?perPage=3&page=1&filters=[{"field":"category_id","type":"eq","value":1}]&fieldsFilters=[]`;
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://autobum.ba/' },
            timeout: 10000
        });
        res.json({ uspjeh: true, ukupno: response.data.total, oglas: response.data.data?.[0] });
    } catch(e) {
        res.json({ uspjeh: false, greska: e.message, status: e.response?.status });
    }
});

fetchSveKategorije();
setInterval(fetchSveKategorije, 2 * 60 * 60 * 1000);

app.listen(PORT, () => console.log(`Server radi na portu ${PORT}`));