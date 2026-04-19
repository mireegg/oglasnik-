const express = require('express');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

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
    await pool.query(`
        CREATE TABLE IF NOT EXISTS korisnici (
            id SERIAL PRIMARY KEY,
            ime VARCHAR(100),
            email VARCHAR(100) UNIQUE,
            lozinka VARCHAR(100),
            datum TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS prijave (
            id SERIAL PRIMARY KEY,
            ime VARCHAR(100),
            email VARCHAR(100),
            telefon VARCHAR(50),
            datum TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pracenja (
            id SERIAL PRIMARY KEY,
            korisnik_email VARCHAR(100),
            pretraga VARCHAR(200),
            aktivno BOOLEAN DEFAULT true,
            datum TIMESTAMP DEFAULT NOW()
        )
    `);
    console.log('Baza inicijalizovana!');
}

initDB();

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.post('/prijava', async (req, res) => {
    const { ime, email, telefon } = req.body;
    await pool.query(
        'INSERT INTO prijave (ime, email, telefon) VALUES ($1, $2, $3)',
        [ime, email, telefon]
    );
    transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Dobro dosli na Oglasnik.ba!',
        html: '<h2>Zdravo ' + ime + '!</h2><p>Uspjesno ste se prijavili za besplatni probni period.</p><br><p>Tim Oglasnik.ba</p>'
    }).catch(e => console.log('Email greska:', e.message));
    res.json({ uspjeh: true });
});

app.post('/register', async (req, res) => {
    const { ime, email, lozinka } = req.body;
    try {
        await pool.query(
            'INSERT INTO korisnici (ime, email, lozinka) VALUES ($1, $2, $3)',
            [ime, email, lozinka]
        );
        console.log('Saljem email na:', email);
        transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Dobro dosli na Oglasnik.ba!',
            html: '<h2>Zdravo ' + ime + '!</h2><p>Vas account je uspjesno kreiran na Oglasnik.ba.</p><br><p>Tim Oglasnik.ba</p>'
        }).catch(e => console.log('Email greska:', e.message));
        res.json({ uspjeh: true });
    } catch(e) {
        if (e.code === '23505') {
            res.json({ uspjeh: false, poruka: 'Email vec postoji!' });
        } else {
            res.json({ uspjeh: false, poruka: 'Greska pri registraciji!' });
        }
    }
});

app.post('/login', async (req, res) => {
    const { email, lozinka } = req.body;
    const result = await pool.query(
        'SELECT * FROM korisnici WHERE email = $1 AND lozinka = $2',
        [email, lozinka]
    );
    if (result.rows.length > 0) {
        const korisnik = result.rows[0];
        res.json({ uspjeh: true, korisnik: { ime: korisnik.ime, email: korisnik.email } });
    } else {
        res.json({ uspjeh: false, poruka: 'Pogresan email ili lozinka!' });
    }
});

app.post('/pracenje', async (req, res) => {
    const { email, pretraga } = req.body;
    await pool.query(
        'INSERT INTO pracenja (korisnik_email, pretraga) VALUES ($1, $2)',
        [email, pretraga]
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
    const result = await pool.query(
        'SELECT * FROM pracenja WHERE korisnik_email = $1 AND aktivno = true',
        [email]
    );
    res.json(result.rows);
});

app.listen(PORT, () => {
    console.log('Server radi na http://localhost:' + PORT);
    const https = require('https');

app.get('/api/oglasi', async (req, res) => {
    const pretraga = req.query.q || '';
    const token = process.env.OLX_TOKEN;

    const options = {
        hostname: 'api.olx.ba',
path: '/listings?limit=20&keyword=' + encodeURIComponent(pretraga),        method: 'GET',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/json'
        }
    };

    const apiReq = https.request(options, apiRes => {
        let body = '';
        apiRes.on('data', chunk => body += chunk);
        apiRes.on('end', () => {
            try {
                const data = JSON.parse(body);
                res.json(data);
            } catch(e) {
                res.json({ error: 'Greska pri parsiranju' });
            }
        });
    });

    apiReq.on('error', e => res.json({ error: e.message }));
    apiReq.end();
});
});