const cheerio = require('cheerio');
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
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    await pool.query(`ALTER TABLE pracenja ADD COLUMN IF NOT EXISTS slika TEXT`);
    await pool.query(`ALTER TABLE pracenja ADD COLUMN IF NOT EXISTS link TEXT`);
    await pool.query(`CREATE TABLE IF NOT EXISTS korisnici (id SERIAL PRIMARY KEY, ime VARCHAR(100), email VARCHAR(100) UNIQUE, lozinka VARCHAR(100), datum TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS prijave (id SERIAL PRIMARY KEY, ime VARCHAR(100), email VARCHAR(100), telefon VARCHAR(50), datum TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pracenja (id SERIAL PRIMARY KEY, korisnik_email VARCHAR(100), pretraga VARCHAR(200), aktivno BOOLEAN DEFAULT true, datum TIMESTAMP DEFAULT NOW())`);
    console.log('Baza inicijalizovana!');
}
initDB();

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.post('/prijava', async (req, res) => {
    const { ime, email, telefon } = req.body;
    await pool.query('INSERT INTO prijave (ime, email, telefon) VALUES ($1, $2, $3)', [ime, email, telefon]);
    transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject: 'Dobro dosli na Oglix!', html: '<h2>Zdravo ' + ime + '!</h2><p>Uspjesno ste se prijavili.</p>' }).catch(e => console.log(e.message));
    res.json({ uspjeh: true });
});

app.post('/register', async (req, res) => {
    const { ime, email, lozinka } = req.body;
    if (!ime || !email || !lozinka) return res.json({ uspjeh: false, poruka: 'Sva polja su obavezna!' });
    if (lozinka.length < 6) return res.json({ uspjeh: false, poruka: 'Lozinka mora imati min. 6 karaktera!' });

    try {
        const hash = await bcrypt.hash(lozinka, SALT_ROUNDS);
        const result = await pool.query(
            'INSERT INTO korisnici (ime, email, lozinka) VALUES ($1, $2, $3) RETURNING id, ime, email',
            [ime, email, hash]
        );
        const korisnik = result.rows[0];
        transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Dobro došli na Oglix!',
            html: `<h2>Zdravo ${ime}!</h2><p>Vaš account je uspješno kreiran.</p>`
        }).catch(e => console.log('Email greška:', e.message));
        res.json({ uspjeh: true, korisnik: { ime: korisnik.ime, email: korisnik.email } });
    } catch (e) {
        if (e.code === '23505') {
            res.json({ uspjeh: false, poruka: 'Email adresa je već registrovana!' });
        } else {
            res.json({ uspjeh: false, poruka: 'Greška pri registraciji. Pokušaj ponovo.' });
        }
    }
});

app.post('/login', async (req, res) => {
    const { email, lozinka } = req.body;
    if (!email || !lozinka) return res.json({ uspjeh: false, poruka: 'Unesite email i lozinku!' });

    try {
        const result = await pool.query('SELECT * FROM korisnici WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.json({ uspjeh: false, poruka: 'Pogrešan email ili lozinka!' });

        const korisnik = result.rows[0];
        const poklapanje = await bcrypt.compare(lozinka, korisnik.lozinka);
        if (poklapanje) {
            res.json({ uspjeh: true, korisnik: { ime: korisnik.ime, email: korisnik.email } });
        } else {
            res.json({ uspjeh: false, poruka: 'Pogrešan email ili lozinka!' });
        }
    } catch (e) {
        res.json({ uspjeh: false, poruka: 'Greška pri prijavi. Pokušaj ponovo.' });
    }
});

app.post('/pracenje', async (req, res) => {
    const { email, pretraga, link, slika } = req.body;
    await pool.query(
        'INSERT INTO pracenja (korisnik_email, pretraga, link, slika) VALUES ($1, $2, $3, $4)',
        [email, pretraga, link || null, slika || null]
    );
    res.json({ uspjeh: true });
});

app.delete('/pracenje/:id', async (req, res) => {
    const { id } = req.params;
    await pool.query('DELETE FROM pracenja WHERE id = $1', [id]);
    res.json({ uspjeh: true });
});

app.get('/moja-pracenja', async (req, res) => {
    const { email } = req.query;
    const result = await pool.query('SELECT * FROM pracenja WHERE korisnik_email = $1 AND aktivno = true', [email]);
    res.json(result.rows);
});

app.post('/ai-analiza', async (req, res) => {
    const { oglasi, pretraga } = req.body;

    const prompt = `Ti si iskusan auto-ekspert i savjetnik za kupovinu vozila u Bosni i Hercegovini. 
Kupac trazi: "${pretraga}"

Evo oglasa koje je pronasao:

${oglasi.map((o, i) => `${i+1}. OGLAS:
   Naziv: ${o.naslov}
   Cijena: ${o.cijenaStr}
   Lokacija: ${o.lokacija}
   Detalji: ${o.detalji || 'nema detalja'}
   Platforma: ${o.platforma.toUpperCase()}`).join('\n\n')}

Za svaki oglas analiziraj sljedece:
1. CIJENA: Da li je cijena fer, previsoka ili preniska u odnosu na tržište BiH?
2. PREPORUKA: PREPORUCUJEM / OK / IZBJEGAVAJ
3. AI SCORE: Daj ocjenu od 1 do 100.

Na kraju napisi ZAKLJUCAK: Koji oglas je najisplativija kupovina i zasto?
Pisi na bosanskom/hrvatskom jeziku. Budi konkretan i koristan kupcu.`;

    const body = JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1500
    });

    const options = {
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + process.env.GROQ_API_KEY,
            'Content-Length': Buffer.byteLength(body)
        }
    };

    const apiReq = https.request(options, apiRes => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                const tekst = parsed.choices[0].message.content;
                res.json({ uspjeh: true, analiza: tekst });
            } catch(e) {
                res.json({ uspjeh: false, poruka: 'Greska pri analizi' });
            }
        });
    });

    apiReq.on('error', e => res.json({ uspjeh: false, poruka: e.message }));
    apiReq.write(body);
    apiReq.end();
});

app.post('/api/sacuvaj-oglase', async (req, res) => {
    const { oglasi } = req.body;
    if (!oglasi || oglasi.length === 0) return res.json({ uspjeh: false });

    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS live_oglasi (
        
            id SERIAL PRIMARY KEY,
            naslov TEXT,
            cijena TEXT,
            slika TEXT,
            link TEXT UNIQUE,
            platforma VARCHAR(50) DEFAULT 'olx',
            kategorija VARCHAR(100),
            datum TIMESTAMP DEFAULT NOW()
            
        )`);
        await pool.query(`ALTER TABLE pracenja ADD COLUMN IF NOT EXISTS link TEXT`);

        await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS kategorija VARCHAR(100)`);

        for (const o of oglasi) {
            await pool.query(
                `INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (link) DO UPDATE SET kategorija = $6`,
                [o.naslov, o.cijena, o.slika, o.link, o.platforma, o.kategorija || null]
            );
        }

        res.json({ uspjeh: true, sacuvano: oglasi.length });
    } catch(e) {
        console.log('Greška:', e.message);
        res.json({ uspjeh: false, poruka: e.message });
    }
});

app.get('/api/live-oglasi', async (req, res) => {
    try {
        const q = req.query.q || '';
        const offset = parseInt(req.query.offset) || 0;
        const limit = parseInt(req.query.limit) || 12;
        const kategorija = req.query.kategorija || '';

        let uvjeti = [];
        let params = [];
        let i = 1;

        if (q) {
            uvjeti.push(`naslov ILIKE $${i++}`);
            params.push(`%${q}%`);
        }

        if (kategorija) {
            const kats = kategorija.split(',').map(k => k.trim());
            const katPlaceholders = kats.map(() => `$${i++}`).join(',');
            uvjeti.push(`kategorija IN (${katPlaceholders})`);
            params.push(...kats);
        }

        const where = uvjeti.length > 0 ? 'WHERE ' + uvjeti.join(' AND ') : '';
        params.push(limit, offset);

        const query = `SELECT * FROM live_oglasi ${where} ORDER BY datum DESC LIMIT $${i++} OFFSET $${i++}`;
        const result = await pool.query(query, params);
        res.json({ uspjeh: true, oglasi: result.rows });
    } catch(e) {
        res.json({ uspjeh: false, oglasi: [] });
    }
});

app.get('/api/kategorije', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT kategorija, COUNT(*) as broj 
             FROM live_oglasi 
             WHERE kategorija IS NOT NULL 
             GROUP BY kategorija 
             ORDER BY broj DESC`
        );
        res.json({ uspjeh: true, kategorije: result.rows });
    } catch(e) {
        res.json({ uspjeh: false, kategorije: [] });
    }
});

app.post('/api/analiza-jednog-oglasa', async (req, res) => {
    const { oglas, slicni } = req.body;

    const prompt = `Ti si iskusan savjetnik za kupovinu u Bosni i Hercegovini.

Oglas koji analiziraš:
- Naziv: ${oglas.naslov}
- Cijena: ${oglas.cijenaStr}
- Kategorija: ${oglas.kategorija || 'nepoznato'}
- Platforma: ${oglas.platforma}

Slični oglasi u bazi:
${slicni.slice(0, 5).map((s, i) => `${i + 1}. ${s.naslov} — ${s.cijenaStr}`).join('\n')}

Tvoj zadatak je da TI uradiš usporedbu, ne kupac. Daj analizu u ovom formatu:
OCJENA: [ODLIČNO/FER/PREVISOKO/IZBJEGAVAJ]
CIJENA: [Napiši konkretno — npr. "Ovaj oglas je za 1.200 KM jeftiniji od sličnih oglasa u bazi" ili "Dva slična oglasa su po 13.500 KM, ovaj je previsok za 2.000 KM"]
SAVJET: [Napiši konkretno da li preporučuješ OVAJ oglas ili koji od sličnih je bolji i zašto — budi direktan]
SCORE: [broj 0-100]`;

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 300,
                temperature: 0.7
            })
        });

        const data = await response.json();
        const tekst = data.choices[0].message.content;
        const scoreMatch = tekst.match(/SCORE:\s*(\d+)/);
        const score = scoreMatch ? parseInt(scoreMatch[1]) : 70;

        res.json({ uspjeh: true, analiza: tekst, score });
    } catch(e) {
        res.json({ uspjeh: false, analiza: 'Analiza nije dostupna.', score: 70 });
    }
});
const OLX_KATEGORIJE = [
    { id: '18', naziv: 'vozila' },
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
];

async function fetchOLXKategorija(categoryId, kategorija) {
    try {
        const url = `https://olx.ba/api/search?attr_encoded=1&category_id=${categoryId}&per_page=40`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json',
                'Referer': 'https://www.olx.ba/'
            },
            timeout: 10000
        });

       const oglasi = (response.data.data || [])
    .filter(o => o.id != trenutni_id)
    .slice(0, 6)
    .map(o => {
        var labels = o.special_labels || [];
        var km = labels.find(l => l.attr_code === 'kilometra-a' || l.label === 'Kilometraža');
        var gorivo = labels.find(l => l.attr_code === 'gorivo' || l.label === 'Gorivo');
        return {
            id: o.id,
            naslov: o.title,
            cijena: o.display_price || 'Na upit',
            slika: o.image || '',
            link: `https://www.olx.ba/artikal/${o.id}`,
            gorivo: gorivo ? gorivo.value : '',
            km: km ? km.value : ''
        };
    });
        console.log(`OLX Auto-fetch: ${sacuvano} novih oglasa za kategoriju ${kategorija}`);
    } catch(e) {
        console.log(`OLX Auto-fetch greška za ${kategorija}:`, e.message);
    }
}

async function fetchOLXKategorija(categoryId, kategorija) {
    try {
        for (let stranica = 1; stranica <= 10; stranica++) {
            const url = `https://olx.ba/api/search?attr_encoded=1&category_id=${categoryId}&per_page=40&page=${stranica}`;
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'application/json',
                    'Referer': 'https://www.olx.ba/'
                },
                timeout: 10000
            });

            const oglasi = response.data.data || [];
            if (oglasi.length === 0) break;

            let sacuvano = 0;
            for (const o of oglasi) {
                try {
                    await pool.query(
                        `INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija)
                         VALUES ($1, $2, $3, $4, $5, $6)
                         ON CONFLICT (link) DO NOTHING`,
                        [o.title, o.display_price || 'Na upit', o.image || '', `https://www.olx.ba/artikal/${o.id}`, 'olx', kategorija]
                    );
                    sacuvano++;
                } catch(e) {}
            }

            console.log(`OLX: stranica ${stranica}, kategorija ${kategorija}, ${sacuvano} novih`);
            await new Promise(r => setTimeout(r, 1000));
        }
    } catch(e) {
        console.log(`OLX greška za ${kategorija}:`, e.message);
    }
}
async function fetchSveKategorije() {
    console.log('Pokrećem OLX auto-fetch...');
    for (const kat of OLX_KATEGORIJE) {
        await fetchOLXKategorija(kat.id, kat.naziv);
        await new Promise(r => setTimeout(r, 2000));
    }
    console.log('OLX auto-fetch završen!');
}

// Pokreni odmah pri startu
fetchSveKategorije();

// Pokreni svakih sat vremena
setInterval(fetchSveKategorije, 60 * 60 * 1000);
app.get('/api/oglas-detalji/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const response = await axios.get(`https://olx.ba/api/listings/${id}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json',
                'Referer': 'https://www.olx.ba/'
            },
            timeout: 10000
        });

        const data = response.data;
        
        // Izvuci atribute
        const attrs = {};
        (data.attributes || []).forEach(function(a) {
            attrs[a.attr_code] = a.value;
        });

        const detalji = {
            id: data.id,
            naslov: data.title,
            opis: data.additional?.description?.replace(/<[^>]*>/g, '').substring(0, 300) || '',
            brand: data.brand?.name || '',
            model: data.model?.name || '',
            brand_id: data.brand?.id || null,
            model_id: data.model_id || null,
            godiste: attrs['godiste'] || null,
            gorivo: attrs['gorivo'] || null,
            transmisija: attrs['transmisija'] || null,
            km: attrs['kilometra-a'] || null,
            kubikaza: attrs['kubikaza'] || null,
            kw: attrs['kilovata-kw'] || null,
            boja: attrs['boja'] || null,
            tip: attrs['tip'] || null,
            grad: data.cities?.[0]?.name || 'BiH',
            slike: data.images || []
        };

        res.json({ uspjeh: true, detalji });
    } catch(e) {
        res.json({ uspjeh: false, poruka: e.message });
    }
});

app.get('/api/slicni-oglasi', async (req, res) => {
    try {
        const { brand_id, cijena_od, cijena_do, trenutni_id } = req.query;
        
        let url = `https://olx.ba/api/search?category_id=18&per_page=8`;
        if (brand_id) url += `&brand=${brand_id}`;
        if (cijena_od) url += `&price_from=${cijena_od}`;
        if (cijena_do) url += `&price_to=${cijena_do}`;

        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json',
                'Referer': 'https://www.olx.ba/'
            },
            timeout: 10000
        });

        const oglasi = (response.data.data || [])
            .filter(o => o.id != trenutni_id)
            .slice(0, 6)
            .map(o => {
                var labels = o.special_labels || [];
                var kmLabel = labels.find(l => l.label === 'Kilometraža');
                var gorivLabel = labels.find(l => l.label === 'Gorivo');
                return {
                    id: o.id,
                    naslov: o.title,
                    cijena: o.display_price || 'Na upit',
                    slika: o.image || '',
                    link: `https://www.olx.ba/artikal/${o.id}`,
                    gorivo: gorivLabel ? gorivLabel.value : '',
                    km: kmLabel ? kmLabel.value : ''
                };
            });

        res.json({ uspjeh: true, oglasi });
    } catch(e) {
        res.json({ uspjeh: false, oglasi: [], poruka: e.message });
    }
});
app.listen(PORT, () => {
    console.log(`Server radi na portu ${PORT}`);
});