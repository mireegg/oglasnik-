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

    if (!ime || !email || !lozinka) {
        return res.json({ uspjeh: false, poruka: 'Sva polja su obavezna!' });
    }
    if (lozinka.length < 6) {
        return res.json({ uspjeh: false, poruka: 'Lozinka mora imati min. 6 karaktera!' });
    }

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
            console.log('Register greška:', e.message);
            res.json({ uspjeh: false, poruka: 'Greška pri registraciji. Pokušaj ponovo.' });
        }
    }
});

app.post('/login', async (req, res) => {
    const { email, lozinka } = req.body;

    if (!email || !lozinka) {
        return res.json({ uspjeh: false, poruka: 'Unesite email i lozinku!' });
    }

    try {
        const result = await pool.query(
            'SELECT * FROM korisnici WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.json({ uspjeh: false, poruka: 'Pogrešan email ili lozinka!' });
        }

        const korisnik = result.rows[0];
        const poklapanje = await bcrypt.compare(lozinka, korisnik.lozinka);

        if (poklapanje) {
            res.json({ uspjeh: true, korisnik: { ime: korisnik.ime, email: korisnik.email } });
        } else {
            res.json({ uspjeh: false, poruka: 'Pogrešan email ili lozinka!' });
        }
    } catch (e) {
        console.log('Login greška:', e.message);
        res.json({ uspjeh: false, poruka: 'Greška pri prijavi. Pokušaj ponovo.' });
    }
});

app.post('/pracenje', async (req, res) => {
    const { email, pretraga } = req.body;
    await pool.query('INSERT INTO pracenja (korisnik_email, pretraga) VALUES ($1, $2)', [email, pretraga]);
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
1. CIJENA: Da li je cijena fer, previsoka ili preniska u odnosu na tržište BiH? Navedi konkretan razlog.
2. KILOMETRAZA: Procijeni da li je kilometraza normalna za godiste vozila.
3. OPREMA: Koja vazna oprema je ukljucena, a sta nedostaje?
4. PREPORUKA: PREPORUCUJEM / OK / IZBJEGAVAJ
5. AI SCORE: Daj ocjenu od 1 do 100.

Na kraju napisi:
ZAKLJUCAK: Koji oglas je najisplativija kupovina i zasto? Na sta kupac posebno treba obratiti paznju prije kupovine?

Pisi na bosanskom/hrvatskom jeziku. Budi konkretan, jasan i koristan kupcu.`;

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
                console.log('Groq odgovor:', data);
                res.json({ uspjeh: false, poruka: 'Greska pri analizi' });
            }
        });
    });

    apiReq.on('error', e => res.json({ uspjeh: false, poruka: e.message }));
    apiReq.write(body);
    apiReq.end();
});

app.get('/api/test-scrape', async (req, res) => {
    try {
        const response = await axios.get('https://www.olx.ba/pretraga?q=golf', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'bs,hr;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 10000
        });

        const $ = cheerio.load(response.data);
        const prvih2000 = response.data.substring(0, 2000);
        const artikli = $('article').length;
        const divovi = $('[class*="listing"]').length;
        const kartice = $('[class*="card"]').length;

        res.json({
            status: response.status,
            html_preview: prvih2000,
            article_count: artikli,
            listing_divs: divovi,
            card_divs: kartice
        });

    } catch(e) {
        res.json({ greska: e.message });
    }
});

app.get('/api/oglasi', async (req, res) => {
    const pretraga = req.query.q || '';

    try {
        const url = `https://www.olx.ba/pretraga?q=${encodeURIComponent(pretraga)}`;

        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'bs,hr;q=0.9,sr;q=0.8',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 10000
        });

        const $ = cheerio.load(response.data);
        const oglasi = [];

        $('article').each((i, el) => {
            const el$ = $(el);
            const naslov = el$.find('h3, h4, .title, [class*="title"]').first().text().trim();
            const cijena = el$.find('[class*="price"], [class*="cijena"]').first().text().trim();
            const lokacija = el$.find('[class*="location"], [class*="lokacija"], [class*="city"]').first().text().trim();
            const slika = el$.find('img').first().attr('src') || '';
            const link = el$.find('a').first().attr('href') || '';

            if (naslov) {
                oglasi.push({
                    naslov,
                    cijenaStr: cijena || 'Cijena na upit',
                    lokacija: lokacija || 'BiH',
                    slika,
                    link: link.startsWith('http') ? link : `https://www.olx.ba${link}`,
                    platforma: 'olx'
                });
            }
        });

        console.log(`Scraped ${oglasi.length} oglasa za: ${pretraga}`);
        res.json({ uspjeh: true, oglasi });

    } catch (e) {
        console.log('Scraping greška:', e.message);
        res.json({ uspjeh: false, poruka: e.message, oglasi: [] });
    }
});

app.get('/api/test-rss', async (req, res) => {
    try {
        const response = await axios.get('https://www.olx.ba/rss/pretraga/?q=golf', {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/rss+xml, application/xml, text/xml'
            },
            timeout: 10000
        });
        res.send(response.data);
    } catch(e) {
        res.json({ greska: e.message });
    }
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

        // Dodaj kategorija kolonu ako ne postoji
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
        let query, params;

        if (q) {
            query = `SELECT * FROM live_oglasi WHERE naslov ILIKE $1 ORDER BY datum DESC LIMIT 50`;
            params = [`%${q}%`];
        } else {
            query = `SELECT * FROM live_oglasi ORDER BY datum DESC LIMIT 50`;
            params = [];
        }

        const result = await pool.query(query, params);
        res.json({ uspjeh: true, oglasi: result.rows });
    } catch(e) {
        res.json({ uspjeh: false, oglasi: [] });
        app.get('/api/live-oglasi', async (req, res) => {
    try {
        const q = req.query.q || '';
        const offset = parseInt(req.query.offset) || 0;
        let query, params;

        if (q) {
            query = `SELECT * FROM live_oglasi WHERE naslov ILIKE $1 ORDER BY datum DESC LIMIT 12 OFFSET $2`;
            params = [`%${q}%`, offset];
        } else {
            query = `SELECT * FROM live_oglasi ORDER BY datum DESC LIMIT 12 OFFSET $1`;
            params = [offset];
        }

        const result = await pool.query(query, params);
        res.json({ uspjeh: true, oglasi: result.rows });
    } catch(e) {
        res.json({ uspjeh: false, oglasi: [] });
    }
});
    }
});
app.listen(PORT, () => {
    app.get('/api/debug-scrape', async (req, res) => {
    try {
        const response = await axios.get('https://www.olx.ba/pretraga?q=golf', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'bs,hr;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 10000
        });

        const $ = cheerio.load(response.data);

        const rezultati = [];
        $('[class*="listing"]').each((i, el) => {
            rezultati.push({
                tag: el.name,
                klase: $(el).attr('class'),
                html_preview: $(el).html()?.substring(0, 300)
            });
        });

        const cijene = [];
        $('[class*="price"], [class*="Price"]').each((i, el) => {
            cijene.push($(el).text().trim());
        });

        res.json({ listing_elementi: rezultati, cijene });

    } catch(e) {
        res.json({ greska: e.message });
    }
});
    console.log('Server radi na http://localhost:' + PORT);
});