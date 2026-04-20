const demoOglasi = [
    { 
        id: 1, 
        naslov: 'VW Golf 7 2.0 TDI DSG 2016 — Plavi, 145.000km, Highline oprema', 
        cijena: 16500, 
        cijenaStr: '16.500 KM', 
        lokacija: 'Sarajevo', 
        platforma: 'olx', 
        emoji: '🚗', 
        score: 88, 
        aiTag: 'good', 
        aiLabel: 'Dobra ponuda',
        datum: '2h',
        detalji: 'Plava boja, DSG mjenjac, 2.0 TDI 150ks, Highline oprema, navigacija, kozna sjedista, xenon, servisna knjiga'
    },
    { 
        id: 2, 
        naslov: 'VW Golf 7 2.0 TDI DSG 2015 — Plavi, 198.000km, Comfortline', 
        cijena: 13900, 
        cijenaStr: '13.900 KM', 
        lokacija: 'Mostar', 
        platforma: 'njuskalo', 
        emoji: '🚗', 
        score: 65, 
        aiTag: 'warn', 
        aiLabel: 'Visoka kilometraza',
        datum: '5h',
        detalji: 'Plava boja, DSG mjenjac, 2.0 TDI 150ks, Comfortline oprema, klima, el. prozori, bez navigacije'
    },
    { 
        id: 3, 
        naslov: 'VW Golf 7 2.0 TDI DSG 2017 — Plavi, 89.000km, R-Line paket', 
        cijena: 21500, 
        cijenaStr: '21.500 KM', 
        lokacija: 'Banja Luka', 
        platforma: 'olx', 
        emoji: '🚗', 
        score: 92, 
        aiTag: 'good', 
        aiLabel: 'Odlicna ponuda',
        datum: '1h',
        detalji: 'Plava boja, DSG mjenjac, 2.0 TDI 150ks, R-Line paket, navigacija, kamera, kozna sjedista, puna oprema, jedan vlasnik'
    },
    { 
        id: 4, 
        naslov: 'VW Golf 7 2.0 TDI DSG 2016 — Plavi, 167.000km, Trendline', 
        cijena: 14500, 
        cijenaStr: '14.500 KM', 
        lokacija: 'Tuzla', 
        platforma: 'facebook', 
        emoji: '🚗', 
        score: 55, 
        aiTag: 'warn', 
        aiLabel: 'Malo opreme za cijenu',
        datum: '8h',
        detalji: 'Plava boja, DSG mjenjac, 2.0 TDI 150ks, Trendline osnovna oprema, klima, bez navigacije, bez kozone'
    },
    { 
        id: 5, 
        naslov: 'VW Golf 7 2.0 TDI DSG 2018 — Plavi, 112.000km, Highline+', 
        cijena: 24900, 
        cijenaStr: '24.900 KM', 
        lokacija: 'Zenica', 
        platforma: 'njuskalo', 
        emoji: '🚗', 
        score: 78, 
        aiTag: 'warn', 
        aiLabel: 'Malo skuplje od prosjeka',
        datum: '3h',
        detalji: 'Plava boja, DSG mjenjac, 2.0 TDI 150ks, Highline+ oprema, panorama krov, navigacija, kamera, kozna, ACC'
    },
];

let trenutniOglasi = [...demoOglasi];
let aktivnaPlatforma = 'sve';
let aktivnoSortiranje = 'novo';

function prikaziOglase(oglasi) {
    const grid = document.getElementById('oglasiGrid');
    const info = document.getElementById('rezultatiInfo');

    info.textContent = 'Pronadeno ' + oglasi.length + ' oglasa';

    if (oglasi.length === 0) {
        grid.innerHTML = '<div class="loader">Nema rezultata za ovu pretragu.</div>';
        return;
    }

    grid.innerHTML = oglasi.map(o => {
        const scoreColor = o.score >= 75 ? '#639922' : o.score >= 50 ? '#BA7517' : '#A32D2D';
        return '<div class="oglas-card">' +
            '<div class="oglas-slika">' + o.emoji + '</div>' +
            '<div class="oglas-body">' +
            '<div class="oglas-naslov">' + o.naslov + '</div>' +
            '<div class="oglas-cijena">' + o.cijenaStr + '</div>' +
            '<div class="oglas-meta"><span class="oglas-lokacija">📍 ' + o.lokacija + ' · ' + o.datum + '</span>' +
            '<span class="oglas-platforma platforma-' + o.platforma + '">' + o.platforma.toUpperCase() + '</span></div>' +
            '<div class="ai-score">' +
            '<span class="ai-tag ai-' + o.aiTag + '">' + o.aiLabel + '</span>' +
            '<div class="score-bar-wrap"><div class="score-bar-fill" style="width:' + o.score + '%;background:' + scoreColor + ';"></div></div>' +
            '<span class="score-label" style="color:' + scoreColor + ';">' + o.score + '</span>' +
            '</div></div></div>';
    }).join('');
}

function pretrazi() {
    const query = document.getElementById('searchInput').value.trim();
    if (!query) return;
    window.open('https://www.olx.ba/pretraga?keywords=' + encodeURIComponent(query), '_blank');
}

function filterPlatforma(btn, platforma) {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    aktivnaPlatforma = platforma;
    var filtrirani = aktivnaPlatforma === 'sve' ? [...demoOglasi] : demoOglasi.filter(o => o.platforma === aktivnaPlatforma);
    prikaziOglase(filtrirani);
}

function sortiraj(btn, tip) {
    document.querySelectorAll('.filter-btn').forEach(b => {
        if (['novo','cijena_asc','cijena_desc','score'].some(s => b.onclick && b.onclick.toString().includes(s))) {
            b.classList.remove('active');
        }
    });
    btn.classList.add('active');
    aktivnoSortiranje = tip;
    var oglasi = [...demoOglasi];
    switch(tip) {
        case 'cijena_asc': oglasi.sort((a, b) => a.cijena - b.cijena); break;
        case 'cijena_desc': oglasi.sort((a, b) => b.cijena - a.cijena); break;
        case 'score': oglasi.sort((a, b) => b.score - a.score); break;
    }
    prikaziOglase(oglasi);
}

window.onload = () => prikaziOglase(demoOglasi);

document.addEventListener('keydown', e => {
    if (e.key === 'Enter') pretrazi();
});