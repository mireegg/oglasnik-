const express = require('express');
const fs = require('fs');
const nodemailer = require('nodemailer');
const app = express();
const PORT = 3000;

app.use(express.static('public'));
app.use(express.json());

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'mrcakano@gmail.com',
        pass: 'zbmumqoypqmycsel'
    }
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.post('/prijava', (req, res) => {
    const { ime, email, telefon } = req.body;
    let prijave = [];
    if (fs.existsSync('prijave.json')) {
        prijave = JSON.parse(fs.readFileSync('prijave.json'));
    }
    prijave.push({ ime, email, telefon, datum: new Date().toLocaleString('bs-BA') });
    fs.writeFileSync('prijave.json', JSON.stringify(prijave, null, 2));

    transporter.sendMail({
        from: 'mrcakano@gmail.com',
        to: email,
        subject: 'Dobro dosli na Oglasnik.ba!',
        html: '<h2>Zdravo ' + ime + '!</h2><p>Uspjesno ste se prijavili za besplatni probni period.</p><p>Kontaktirat cemo vas uskoro.</p><br><p>Tim Oglasnik.ba</p>'
    }).catch(e => console.log('Email greska:', e.message));

    res.json({ uspjeh: true });
});

app.post('/register', (req, res) => {
    const { ime, email, lozinka } = req.body;
    let korisnici = [];
    if (fs.existsSync('korisnici.json')) {
        korisnici = JSON.parse(fs.readFileSync('korisnici.json'));
    }
    const postoji = korisnici.find(k => k.email === email);
    if (postoji) {
        return res.json({ uspjeh: false, poruka: 'Email vec postoji!' });
    }
    korisnici.push({
        id: Date.now(),
        ime, email, lozinka,
        pracenja: [],
        datum: new Date().toLocaleString('bs-BA')
    });
    fs.writeFileSync('korisnici.json', JSON.stringify(korisnici, null, 2));

    console.log('Saljem email na:', email);
    transporter.sendMail({
        from: 'mrcakano@gmail.com',
        to: email,
        subject: 'Dobro dosli na Oglasnik.ba!',
        html: '<h2>Zdravo ' + ime + '!</h2><p>Vas account je uspjesno kreiran na Oglasnik.ba.</p><p>Sada mozete pratiti oglase sa svih platformi u BiH.</p><br><p>Tim Oglasnik.ba</p>'
    }).catch(e => console.log('Email greska:', e.message));

    res.json({ uspjeh: true });
});

app.post('/login', (req, res) => {
    const { email, lozinka } = req.body;
    let korisnici = [];
    if (fs.existsSync('korisnici.json')) {
        korisnici = JSON.parse(fs.readFileSync('korisnici.json'));
    }
    const korisnik = korisnici.find(k => k.email === email && k.lozinka === lozinka);
    if (korisnik) {
        res.json({ uspjeh: true, korisnik: { ime: korisnik.ime, email: korisnik.email } });
    } else {
        res.json({ uspjeh: false, poruka: 'Pogresan email ili lozinka!' });
    }
});

app.post('/pracenje', (req, res) => {
    const { email, pretraga } = req.body;
    let korisnici = [];
    if (fs.existsSync('korisnici.json')) {
        korisnici = JSON.parse(fs.readFileSync('korisnici.json'));
    }
    const idx = korisnici.findIndex(k => k.email === email);
    if (idx === -1) return res.json({ uspjeh: false });
    if (!korisnici[idx].pracenja) korisnici[idx].pracenja = [];
    korisnici[idx].pracenja.push({
        id: Date.now(),
        pretraga,
        datum: new Date().toLocaleString('bs-BA'),
        aktivno: true
    });
    fs.writeFileSync('korisnici.json', JSON.stringify(korisnici, null, 2));
    res.json({ uspjeh: true });
});

app.post('/notifikacija', (req, res) => {
    const { email, naslov, cijena, link, pretraga } = req.body;
    transporter.sendMail({
        from: 'mrcakano@gmail.com',
        to: email,
        subject: 'Nov oglas za "' + pretraga + '" - ' + cijena,
        html: '<h2>Pronasli smo novi oglas za tebe!</h2><p><b>' + naslov + '</b></p><p>Cijena: <b>' + cijena + '</b></p><a href="' + link + '" style="background:#3C3489;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;">Pogledaj oglas</a><br><br><p>Tim Oglasnik.ba</p>'
    }).then(() => {
        res.json({ uspjeh: true });
    }).catch(e => {
        console.log('Email greska:', e.message);
        res.json({ uspjeh: false });
    });
});

app.listen(PORT, () => {
    console.log('Server radi na http://localhost:' + PORT);
});