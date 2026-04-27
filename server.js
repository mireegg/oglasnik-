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

async function groqAI(prompt, maxTokens = 500) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0.4 })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
}

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
                // Vozila
                godiste: attrs['godiste'] || null,
                gorivo: attrs['gorivo'] || null,
                transmisija: attrs['transmisija'] || null,
                km: attrs['kilometra-a'] || null,
                kubikaza: attrs['kubikaza'] || null,
                kw: attrs['kilovata-kw'] || null,
                boja: attrs['boja'] || null,
                tip_vozila: attrs['tip'] || null,
                pogon: attrs['pogon'] || null,
                // Mobiteli
                os: attrs['os-operativni-sistem'] || null,
                interna_memorija: attrs['interna-memorija'] || null,
                ram_mob: attrs['ram'] || null,
                // Racunari
                procesor: attrs['procesor'] || null,
                ram_pc: attrs['ram'] || null,
                ssd: attrs['ssd-kapacitet-gb'] || null,
                graficka: attrs['grafi-ka-karta'] || null,
                os_pc: attrs['operativni-sistem'] || null,
                // Nekretnine
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

// ── STARI ENDPOINT (kompatibilnost) ───────────────────────
app.get('/api/slicni-oglasi', async (req, res) => res.json({ uspjeh: true, oglasi: [] }));

// ════════════════════════════════════════════════════════════
// ── GLAVNA LOGIKA: SLIČNI OGLASI — SVE KATEGORIJE ─────────
// POST /api/slicni-dvije-grupe
// ════════════════════════════════════════════════════════════
app.post('/api/slicni-dvije-grupe', async (req, res) => {
    try {
        const d = req.body; // sve detalje šalje frontend
        const kategorija_tip = d.kategorija_tip || 'ostalo';
        const olx_id = d.olx_id;
        const cijenaNum = parseCijena(d.cijena);

        let grupa1 = [], grupa2 = [], preciznost = '', aiAnaliza = null;

        // ════════════════════════════════════════════════════
        // VOZILA
        // ════════════════════════════════════════════════════
        if (kategorija_tip === 'vozila') {
            if (!d.brand_id || !d.model_id) return res.json({ uspjeh: false, grupa1: [], grupa2: [], poruka: 'Nema brand/model za vozilo' });

            const cijenaOd = cijenaNum > 0 ? Math.round(cijenaNum * 0.55) : 0;
            const cijenaDo = cijenaNum > 0 ? Math.round(cijenaNum * 1.55) : 999999;
            let searchUrl = `https://olx.ba/api/search?category_id=18&per_page=40&brand=${d.brand_id}&brands=${d.brand_id}&models=${d.model_id}`;
            if (cijenaOd > 0) searchUrl += `&price_from=${cijenaOd}&price_to=${cijenaDo}`;

            const searchRes = await axios.get(searchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
                timeout: 12000
            });

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

            // Pokušaj 1: gorivo + kubikaza + kw + godiste±1 + boja
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
            grupa2 = svi.filter(o => !g1ids.has(o.id) && (!d.gorivo || !o.gorivo || o.gorivo.toLowerCase()===d.gorivo.toLowerCase()))
                .sort((a,b) => (a.km||999999)-(b.km||999999)).slice(0, 4);

            // AI za vozila
            if (grupa1.length > 0) {
                const aiPrompt = `Ti si direktan savjetnik za kupovinu vozila u BiH.

OGLAS KOJI KUPAC GLEDA:
- Cijena: ${d.cijena} | Godište: ${d.godiste||'—'} | Gorivo: ${d.gorivo||'—'}
- Kubikaža: ${d.kubikaza ? d.kubikaza+'L' : '—'} | Snaga: ${d.kw ? d.kw+' kW' : '—'}
- Transmisija: ${d.transmisija||'—'} | Boja: ${d.boja||'—'} | KM: ${d.km ? parseInt(d.km).toLocaleString()+' km' : '—'}

IDENTIČNI OGLASI (${preciznost}):
${grupa1.map((o,i) => {
    const c = parseCijena(o.cijena);
    const odnos = c && cijenaNum ? (c < cijenaNum ? ` (−${Math.round((cijenaNum-c)/cijenaNum*100)}% jeftiniji)` : c > cijenaNum ? ` (+${Math.round((c-cijenaNum)/cijenaNum*100)}% skuplji)` : ' (ista cijena)') : '';
    return `Oglas #${i+1}: ${o.naslov}
  Cijena: ${o.cijena}${odnos}
  KM: ${o.km ? o.km.toLocaleString()+' km' : '—'} | Godište: ${o.godiste||'—'} | Boja: ${o.boja||'—'} | Transmisija: ${o.transmisija||'—'}`;
}).join('\n\n')}

Format odgovora:
ZAKLJUČAK: [3-4 rečenice sa konkretnim brojevima — koja je prosječna cijena, koji oglas ima najmanje km, koliko je ovaj oglas jeftiniji/skuplji od prosjeka]
PREPORUKA: [Jedna direktna rečenica — "Kupi oglas #X jer..." ili "Pregovaraj — tržišna vrijednost je X KM" ili "Dobar deal, kupi odmah"]
UPOZORENJE: [Samo ako ima konkretan razlog — previše km, previše skupo. Ako je sve OK preskoči.]

Bosanski. Direktno. Bez diplomatisanja.`;
                aiAnaliza = await groqAI(aiPrompt, 500);
            }
        }

        // ════════════════════════════════════════════════════
        // MOBITELI
        // ════════════════════════════════════════════════════
        else if (kategorija_tip === 'mobiteli') {
            if (!d.brand_id && !d.model_id) return res.json({ uspjeh: false, grupa1: [], grupa2: [], poruka: 'Nema brand/model za mobitel' });

            const cijenaOd = cijenaNum > 0 ? Math.round(cijenaNum * 0.60) : 0;
            const cijenaDo = cijenaNum > 0 ? Math.round(cijenaNum * 1.50) : 999999;

            let searchUrl = `https://olx.ba/api/search?category_id=31&per_page=40`;
            if (d.brand_id) searchUrl += `&brand=${d.brand_id}&brands=${d.brand_id}`;
            if (d.model_id) searchUrl += `&models=${d.model_id}`;
            if (cijenaOd > 0) searchUrl += `&price_from=${cijenaOd}&price_to=${cijenaDo}`;

            const searchRes = await axios.get(searchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
                timeout: 12000
            });

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
                        os: attrs['os-operativni-sistem'] || null,
                        interna_memorija: attrs['interna-memorija'] || null,
                        ram: attrs['ram'] || null,
                    };
                } catch(e) { return null; }
            });

            const svi = (await Promise.all(detaljPromises)).filter(Boolean);

            // Pokušaj 1: isti model + ista interna memorija
            if (d.model_id && d.interna_memorija) {
                grupa1 = svi.filter(o => o.interna_memorija === d.interna_memorija);
                if (grupa1.length >= 2) preciznost = 'Isti model i memorija';
            }
            // Pokušaj 2: isti model, različita memorija
            if (grupa1.length < 2) {
                grupa1 = svi.filter(o => true); // već filtrirani po modelu
                preciznost = 'Isti model';
            }

            grupa1 = grupa1.sort((a,b) => (a.cijena_num||999999)-(b.cijena_num||999999)).slice(0, 6);
            const g1ids = new Set(grupa1.map(o=>o.id));
            // Alternativa: isti brand, drugačiji model
            grupa2 = svi.filter(o => !g1ids.has(o.id)).slice(0, 4);

            // AI za mobitele
            if (grupa1.length > 0) {
                const aiPrompt = `Ti si iskusan savjetnik za kupovinu mobitela u BiH. Dobro poznaješ tržište i znaš procijeniti stanje uređaja.

MOBITEL KOJI KUPAC GLEDA:
- Naziv: ${d.brand} ${d.model}
- Cijena: ${d.cijena}
- OS: ${d.os||'—'} | Interna memorija: ${d.interna_memorija||'—'} | RAM: ${d.ram_mob||'—'}
- Stanje: Polovan

IDENTIČNI OGLASI NA TRŽIŠTU (${preciznost}):
${grupa1.map((o,i) => {
    const c = parseCijena(o.cijena);
    const odnos = c && cijenaNum ? (c < cijenaNum ? ` (−${Math.round((cijenaNum-c)/cijenaNum*100)}% jeftiniji)` : c > cijenaNum ? ` (+${Math.round((c-cijenaNum)/cijenaNum*100)}% skuplji)` : ' (ista cijena)') : '';
    return `Oglas #${i+1}: ${o.naslov}
  Cijena: ${o.cijena}${odnos}
  Memorija: ${o.interna_memorija||'—'} | RAM: ${o.ram||'—'}`;
}).join('\n\n')}

Napravi analizu u TAČNO ovom formatu:
ZAKLJUČAK: [3-4 rečenice. Koja je prosječna tržišna cijena ovog modela? Je li ova cijena fer? Koji oglas je najisplativiji?]
PREPORUKA: [Direktna preporuka — "Kupi oglas #X" ili "Ova cijena je realna, kupi odmah" ili "Pregovaraj do X KM"]
UPOZORENJE: [Šta provjeriti pri kupovini — baterija, ekran, oštećenja, originalni dijelovi, FaceID/TouchID. Uvijek napiši ovo za mobitele.]
SAVJET ZA PREGLED: [3 konkretne stvari koje kupac treba fizički provjeriti kod preuzimanja — npr. baterija %, tragovi pada, radi li kamera]

Bosanski. Direktno.`;
                aiAnaliza = await groqAI(aiPrompt, 600);
            }
        }

        // ════════════════════════════════════════════════════
        // RAČUNARI (Desktop i Laptop)
        // ════════════════════════════════════════════════════
        else if (kategorija_tip === 'racunari') {
            const categoryId = d.category_id || 38;
            const cijenaOd = cijenaNum > 0 ? Math.round(cijenaNum * 0.55) : 0;
            const cijenaDo = cijenaNum > 0 ? Math.round(cijenaNum * 1.55) : 999999;

            let searchUrl = `https://olx.ba/api/search?category_id=${categoryId}&per_page=40`;
            if (d.brand_id) searchUrl += `&brand=${d.brand_id}&brands=${d.brand_id}`;
            if (cijenaOd > 0) searchUrl += `&price_from=${cijenaOd}&price_to=${cijenaDo}`;

            const searchRes = await axios.get(searchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
                timeout: 12000
            });

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
                        procesor: attrs['procesor'] || null,
                        ram: attrs['ram'] || null,
                        ssd: attrs['ssd-kapacitet-gb'] || null,
                        graficka: attrs['grafi-ka-karta'] || null,
                        os_pc: attrs['operativni-sistem'] || null,
                    };
                } catch(e) { return null; }
            });

            const svi = (await Promise.all(detaljPromises)).filter(Boolean);

            // Pokušaj 1: isti procesor + isti RAM + ista grafička
            if (d.procesor && d.ram_pc && d.graficka) {
                grupa1 = svi.filter(o =>
                    o.procesor === d.procesor &&
                    o.ram === d.ram_pc &&
                    o.graficka === d.graficka
                );
                if (grupa1.length >= 2) preciznost = 'Isti procesor, RAM i grafička';
            }
            // Pokušaj 2: isti procesor + isti RAM
            if (grupa1.length < 2 && d.procesor && d.ram_pc) {
                grupa1 = svi.filter(o => o.procesor === d.procesor && o.ram === d.ram_pc);
                if (grupa1.length >= 2) preciznost = 'Isti procesor i RAM';
            }
            // Pokušaj 3: samo isti procesor
            if (grupa1.length < 2 && d.procesor) {
                grupa1 = svi.filter(o => o.procesor === d.procesor);
                if (grupa1.length >= 2) preciznost = 'Isti procesor';
            }
            // Pokušaj 4: slična cijena, ista kategorija
            if (grupa1.length < 2) {
                grupa1 = svi;
                preciznost = 'Slična kategorija i cijena';
            }

            grupa1 = grupa1.sort((a,b) => (a.cijena_num||999999)-(b.cijena_num||999999)).slice(0, 6);
            const g1ids = new Set(grupa1.map(o=>o.id));
            grupa2 = svi.filter(o => !g1ids.has(o.id)).slice(0, 4);

            // AI za računare
            if (grupa1.length > 0) {
                const aiPrompt = `Ti si iskusan savjetnik za kupovinu računara u BiH. Dobro razumiješ hardver i znaš realne cijene komponenti.

RAČUNAR KOJI KUPAC GLEDA:
- Naziv: ${d.naslov||'—'}
- Cijena: ${d.cijena}
- Procesor: ${d.procesor||'—'} | RAM: ${d.ram_pc||'—'} | SSD: ${d.ssd ? d.ssd+'GB' : '—'}
- Grafička: ${d.graficka||'—'} | OS: ${d.os_pc||'—'}

SLIČNI RAČUNARI NA TRŽIŠTU (${preciznost}):
${grupa1.map((o,i) => {
    const c = parseCijena(o.cijena);
    const odnos = c && cijenaNum ? (c < cijenaNum ? ` (−${Math.round((cijenaNum-c)/cijenaNum*100)}% jeftiniji)` : c > cijenaNum ? ` (+${Math.round((c-cijenaNum)/cijenaNum*100)}% skuplji)` : ' (ista cijena)') : '';
    return `Oglas #${i+1}: ${o.naslov}
  Cijena: ${o.cijena}${odnos}
  CPU: ${o.procesor||'—'} | RAM: ${o.ram||'—'} | SSD: ${o.ssd ? o.ssd+'GB' : '—'} | GPU: ${o.graficka||'—'}`;
}).join('\n\n')}

Napravi analizu u TAČNO ovom formatu:
ZAKLJUČAK: [3-4 rečenice. Koliko vrijede ove komponente na tržištu? Je li ova cijena fer za te specifikacije? Koji oglas nudi najviše za novac?]
PREPORUKA: [Direktna preporuka — "Kupi oglas #X — bolja grafička za istu cijenu" ili "Ova konfiguracija vrijedi X KM, pregovaraj" ili "Odličan deal, kupi odmah"]
UPOZORENJE: [Šta provjeriti — da li GPU radi stabilno, koliko je SSD iskorišten, stanje matične ploče, napajanje, garancija. Uvijek napiši ovo.]
PERFORMANSE: [Za šta je ovaj računar dobar — gaming na kojim settingsima, video editing, kancelarijski rad]

Bosanski. Direktno. Kao stručnjak za IT.`;
                aiAnaliza = await groqAI(aiPrompt, 600);
            }
        }

        // ════════════════════════════════════════════════════
        // NEKRETNINE
        // ════════════════════════════════════════════════════
        else if (kategorija_tip === 'nekretnine') {
            const categoryId = d.category_id || 23;
            const cijenaOd = cijenaNum > 0 ? Math.round(cijenaNum * 0.65) : 0;
            const cijenaDo = cijenaNum > 0 ? Math.round(cijenaNum * 1.40) : 999999;
            const kvadrati = parseFloat(d.kvadrata) || 0;

            let searchUrl = `https://olx.ba/api/search?category_id=${categoryId}&per_page=40`;
            if (cijenaOd > 0) searchUrl += `&price_from=${cijenaOd}&price_to=${cijenaDo}`;

            const searchRes = await axios.get(searchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
                timeout: 12000
            });

            const kandidati = (searchRes.data.data || []).filter(o => String(o.id) !== String(olx_id));
            const detaljPromises = kandidati.slice(0, 20).map(async (o) => {
                try {
                    const { data: oData, attrs, images } = await dohvatiOlxDetalje(o.id);
                    const kv = parseFloat(attrs['kvadrata']) || 0;
                    return {
                        id: o.id, naslov: o.title,
                        cijena: o.display_price || 'Na upit',
                        cijena_num: parseCijena(o.display_price),
                        slika: o.image || images[0] || '',
                        link: `https://www.olx.ba/artikal/${o.id}`,
                        platforma: 'olx',
                        kvadrata: kv || null,
                        broj_soba: attrs['broj-soba'] || null,
                        sprat: attrs['sprat'] || null,
                        namjesten: attrs['namjesten'] || null,
                        grijanje: attrs['vrsta-grijanja'] || null,
                        grad: oData.cities?.[0]?.name || null,
                        // Cijena po m2
                        cijena_m2: kv > 0 && parseCijena(o.display_price) > 0 ? Math.round(parseCijena(o.display_price) / kv) : null,
                    };
                } catch(e) { return null; }
            });

            const svi = (await Promise.all(detaljPromises)).filter(Boolean);
            const cijenaM2Trenutni = kvadrati > 0 && cijenaNum > 0 ? Math.round(cijenaNum / kvadrati) : 0;

            // Pokušaj 1: isti broj soba + kvadratura ±15m2 + isti grad
            if (d.broj_soba) {
                grupa1 = svi.filter(o => {
                    if (o.broj_soba !== d.broj_soba) return false;
                    if (kvadrati && o.kvadrata && Math.abs(o.kvadrata - kvadrati) > 15) return false;
                    if (d.grad && o.grad && !o.grad.toLowerCase().includes(d.grad.toLowerCase().split(' ')[0])) return false;
                    return true;
                });
                if (grupa1.length >= 2) preciznost = `Isti tip (${d.broj_soba}), slična kvadratura, isti grad`;
            }
            // Pokušaj 2: isti broj soba + isti grad, bez kvadrature
            if (grupa1.length < 2 && d.broj_soba) {
                grupa1 = svi.filter(o => o.broj_soba === d.broj_soba);
                if (grupa1.length >= 2) preciznost = `Isti tip stana (${d.broj_soba})`;
            }
            // Pokušaj 3: slična kvadratura ±20m2
            if (grupa1.length < 2 && kvadrati) {
                grupa1 = svi.filter(o => o.kvadrata && Math.abs(o.kvadrata - kvadrati) <= 20);
                preciznost = `Slična kvadratura (${kvadrati}m² ±20)`;
            }
            // Pokušaj 4: sve u cijenovnom rangu
            if (grupa1.length < 2) {
                grupa1 = svi;
                preciznost = 'Slična cijena, isti tip nekretnine';
            }

            // Sortiraj po cijeni/m2 (manja = bolja)
            grupa1 = grupa1.sort((a,b) => (a.cijena_m2||999999)-(b.cijena_m2||999999)).slice(0, 6);
            const g1ids = new Set(grupa1.map(o=>o.id));
            grupa2 = svi.filter(o => !g1ids.has(o.id)).slice(0, 4);

            // AI za nekretnine
            if (grupa1.length > 0) {
                const aiPrompt = `Ti si iskusan agent za nekretnine u BiH. Odlično poznaješ tržište i cijene po m².

NEKRETNINA KOJU KUPAC GLEDA:
- Naziv: ${d.naslov||'—'}
- Cijena: ${d.cijena} ${cijenaM2Trenutni > 0 ? `(${cijenaM2Trenutni} KM/m²)` : ''}
- Površina: ${d.kvadrata ? d.kvadrata+'m²' : '—'} | Sobe: ${d.broj_soba||'—'}
- Sprat: ${d.sprat||'—'} | Namješteno: ${d.namjesten||'—'} | Grijanje: ${d.grijanje||'—'}
- Grad: ${d.grad||'—'}

SLIČNE NEKRETNINE NA TRŽIŠTU (${preciznost}):
${grupa1.map((o,i) => {
    const c = parseCijena(o.cijena);
    const odnos = c && cijenaNum ? (c < cijenaNum ? ` (−${Math.round((cijenaNum-c)/cijenaNum*100)}% jeftinija)` : c > cijenaNum ? ` (+${Math.round((c-cijenaNum)/cijenaNum*100)}% skuplja)` : ' (ista cijena)') : '';
    return `Oglas #${i+1}: ${o.naslov}
  Cijena: ${o.cijena}${odnos} ${o.cijena_m2 ? `| ${o.cijena_m2} KM/m²` : ''}
  Površina: ${o.kvadrata ? o.kvadrata+'m²' : '—'} | Sobe: ${o.broj_soba||'—'} | Sprat: ${o.sprat||'—'} | Namješteno: ${o.namjesten||'—'}`;
}).join('\n\n')}

Napravi analizu u TAČNO ovom formatu:
ZAKLJUČAK: [3-4 rečenice. Koja je prosječna cijena po m² za ovaj tip nekretnine u ovom gradu? Je li ova cijena iznad ili ispod tržišne? Koji oglas nudi bolju vrijednost?]
PREPORUKA: [Direktna preporuka — "Kupi oglas #X — ${kvadrati > 0 ? 'X KM/m² jeftinije' : 'bolja lokacija/cijena'}" ili "Pregovaraj do X KM" ili "Fer cijena, kupi odmah"]
UPOZORENJE: [Šta provjeriti — uknjiženo/ZK, stanje instalacija, vlaga, susjedstvo, parking, troškovi režija, procjena vrijednosti od banke. Uvijek napiši ovo.]

Bosanski. Direktno. Kao iskusan agent.`;
                aiAnaliza = await groqAI(aiPrompt, 600);
            }
        }

        res.json({ uspjeh: true, grupa1, grupa2, preciznost, aiAnaliza });

    } catch(e) {
        console.log('Dvije grupe greška:', e.message);
        res.json({ uspjeh: false, grupa1: [], grupa2: [], poruka: e.message });
    }
});

// ── FIX KATEGORIJE ────────────────────────────────────────
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
        const r = await pool.query(`UPDATE live_oglasi SET kategorija = $1 WHERE platforma = 'olx' AND kategorija = 'vozila' AND (${uvjet})`, [b.kat]);
        ukupno += r.rowCount;
    }
    res.json({ uspjeh: true, azurirano: ukupno });
});

// ── OLX FETCH PO BRENDOVIMA ───────────────────────────────
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
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' }, timeout: 15000
        });
        const lastPage = Math.min(prva.data.meta?.last_page || 1, 50);
        const sveStrane = [prva.data.data || []];
        for (let str = 2; str <= lastPage; str++) {
            try {
                const r = await axios.get(`https://olx.ba/api/search?category_id=18&per_page=40&page=${str}&brand=${brandId}&brands=${brandId}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' }, timeout: 15000
                });
                sveStrane.push(r.data.data || []);
                await new Promise(r => setTimeout(r, 800));
            } catch(e) { if (e.response?.status === 429) await new Promise(r => setTimeout(r, 15000)); }
        }
        let sacuvano = 0;
        for (const stranica of sveStrane) {
            for (const o of stranica) {
                try {
                    const dbRes = await pool.query(
                        `INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija, brand_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (link) DO NOTHING`,
                        [o.title, o.display_price || 'Na upit', o.image || '', `https://www.olx.ba/artikal/${o.id}`, 'olx', 'vozila', o.brand_id || null]
                    );
                    if (dbRes.rowCount > 0) sacuvano++;
                } catch(e) {}
            }
        }
        if (sacuvano > 0) console.log(`Brend ${brandId}: ${sacuvano} novih oglasa`);
    } catch(e) { console.log(`Brend ${brandId} greška:`, e.message); }
}

async function fetchOLXKategorija(categoryId, kategorija) {
    try {
        const prvaStrana = await axios.get(`https://olx.ba/api/search?category_id=${categoryId}&per_page=40&page=1`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' }, timeout: 15000
        });
        const lastPage = Math.min(prvaStrana.data.meta?.last_page || 1, 100);
        for (const o of (prvaStrana.data.data || [])) {
            try {
                await pool.query(`INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (link) DO NOTHING`,
                    [o.title, o.display_price || 'Na upit', o.image || '', `https://www.olx.ba/artikal/${o.id}`, 'olx', kategorija]);
            } catch(e) {}
        }
        for (let stranica = 2; stranica <= lastPage; stranica++) {
            try {
                const response = await axios.get(`https://olx.ba/api/search?category_id=${categoryId}&per_page=40&page=${stranica}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' }, timeout: 15000
                });
                const oglasi = response.data.data || [];
                if (!oglasi.length) break;
                for (const o of oglasi) {
                    try {
                        await pool.query(`INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (link) DO NOTHING`,
                            [o.title, o.display_price || 'Na upit', o.image || '', `https://www.olx.ba/artikal/${o.id}`, 'olx', kategorija]);
                    } catch(e) {}
                }
                if (stranica % 50 === 0) console.log(`OLX: ${kategorija} stranica ${stranica}/${lastPage}`);
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
    try {
        const prva = await autobumGet(1, 1);
        const sveStrane = [prva.data || []];
        let nextUrl = prva.links?.next;
        let page = 2;
        while (nextUrl && page <= 9999) {
            try {
                const r = await autobumGet(page, 1);
                sveStrane.push(r.data || []);
                nextUrl = r.links?.next;
                page++;
                await new Promise(r => setTimeout(r, 1000));
            } catch(e) { break; }
        }
        let sacuvano = 0;
        for (const stranica of sveStrane) {
            for (const o of stranica) {
                try {
                    const link = `https://autobum.ba/oglas/${o.id}`;
                    const dbRes = await pool.query(`INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (link) DO NOTHING`,
                        [o.title, o.price || 'Na upit', o.image || '', link, 'autobum', 'vozila']);
                    if (dbRes.rowCount > 0) sacuvano++;
                } catch(e) {}
            }
        }
        console.log(`Autobum: vozila — ${sacuvano} novih oglasa`);
    } catch(e) { console.log('Autobum greška:', e.message); }
    console.log('Autobum fetch završen!');
}

async function fetchSveKategorije() {
    console.log('Pokrećem fetch...');
    for (const brandId of OLX_BRENDOVI) {
        await fetchBrend(brandId);
        await new Promise(r => setTimeout(r, 1000));
    }
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
app.get('/api/test-autobum', async (req, res) => {
    try {
        const data = await autobumGet(1, 1);
        res.json({ uspjeh: true, keys: Object.keys(data), count: data.data?.length, oglas: data.data?.[0] });
    } catch(e) { res.json({ uspjeh: false, greska: e.message }); }
});

fetchSveKategorije();
setInterval(fetchSveKategorije, 2 * 60 * 60 * 1000);

app.listen(PORT, () => console.log(`Server radi na portu ${PORT}`));