// Demo oglasi dok ne dobijemo API pristup
const demoOglasi = [
    { id: 1, naslov: 'iPhone 15 Pro 256GB — kao nov, kutija i kabl', cijena: 2200, cijenaStr: '2.200 KM', lokacija: 'Sarajevo', platforma: 'olx', emoji: '📱', score: 92, aiTag: 'good', aiLabel: '✓ Fer cijena', datum: '2 min' },
    { id: 2, naslov: 'VW Golf 6 1.6 TDI 2011 — 185.000 km, servisna knjiga', cijena: 9800, cijenaStr: '9.800 KM', lokacija: 'Zenica', platforma: 'njuskalo', emoji: '🚗', score: 85, aiTag: 'good', aiLabel: '✓ Dobra ponuda', datum: '15 min' },
    { id: 3, naslov: 'PS5 sa 2 kontrolera i 5 igrica', cijena: 950, cijenaStr: '950 KM', lokacija: 'Mostar', platforma: 'facebook', emoji: '🎮', score: 78, aiTag: 'good', aiLabel: '✓ Realna cijena', datum: '1h' },
    { id: 4, naslov: 'Samsung 65" 4K QLED TV — 2023 godina', cijena: 1800, cijenaStr: '1.800 KM', lokacija: 'Banja Luka', platforma: 'olx', emoji: '📺', score: 88, aiTag: 'good', aiLabel: '✓ Ispod tržišne cijene', datum: '2h' },
    { id: 5, naslov: 'MacBook Pro M2 14" 512GB — malo korišten', cijena: 3200, cijenaStr: '3.200 KM', lokacija: 'Sarajevo', platforma: 'njuskalo', emoji: '💻', score: 55, aiTag: 'warn', aiLabel: '⚠ Malo iznad prosjeka', datum: '3h' },
    { id: 6, naslov: 'Stan 54m² Grbavica — odmah useljiv', cijena: 0, cijenaStr: 'Na upit', lokacija: 'Sarajevo', platforma: 'olx', emoji: '🏠', score: 20, aiTag: 'bad', aiLabel: '✗ Sumnjiv oglas', datum: '4h' },
    { id: 7, naslov: 'Ugaona garnitura — siva tkanina, kao nova', cijena: 480, cijenaStr: '480 KM', lokacija: 'Tuzla', platforma: 'facebook', emoji: '🛋️', score: 72, aiTag: 'good', aiLabel: '✓ Fer cijena', datum: '5h' },
    { id: 8, naslov: 'BMW E60 530d 2006 — 245.000km', cijena: 11500, cijenaStr: '11.500 KM', lokacija: 'Sarajevo', platforma: 'olx', emoji: '🚗', score: 81, aiTag: 'good', aiLabel: '✓ Dobra ponuda', datum: '6h' },
    { id: 9, naslov: 'Xiaomi Robot Usisivač — S10+', cijena: 320, cijenaStr: '320 KM', lokacija: 'Mostar', platforma: 'njuskalo', emoji: '🤖', score: 90, aiTag: 'good', aiLabel: '✓ Odlična cijena', datum: '7h' },
    { id: 10, naslov: 'Nike Air Max 90 — br. 43, nove u kutiji', cijena: 180, cijenaStr: '180 KM', lokacija: 'Banja Luka', platforma: 'facebook', emoji: '👟', score: 65, aiTag: 'warn', aiLabel: '⚠ Provjeri autentičnost', datum: '8h' },
    { id: 11, naslov: 'Yamaha R6 2019 — 18.000km, garažirana', cijena: 14500, cijenaStr: '14.500 KM', lokacija: 'Sarajevo', platforma: 'olx', emoji: '🏍️', score: 87, aiTag: 'good', aiLabel: '✓ Fer cijena', datum: '9h' },
    { id: 12, naslov: 'Canon EOS R6 Mark II + objektiv 24-105mm', cijena: 3800, cijenaStr: '3.800 KM', lokacija: 'Zenica', platforma: 'njuskalo', emoji: '📷', score: 83, aiTag: 'good', aiLabel: '✓ Dobra ponuda', datum: '10h' },
];

let trenutniOglasi = [...demoOglasi];
let aktivnaPlatforma = 'sve';
let aktivnoSortiranje = 'novo';

function prikaziOglase(oglasi) {
    const grid = document.getElementById('oglasiGrid');
    const info = document.getElementById('rezultatiInfo');

    info.textContent = `Pronađeno ${oglasi.length} oglasa`;

    if (oglasi.length === 0) {
        grid.innerHTML = '<div class="loader">😕 Nema rezultata za ovu pretragu.</div>';
        return;
    }

    grid.innerHTML = oglasi.map(o => {
    const scoreColor = o.score >= 75 ? '#639922' : o.score >= 50 ? '#BA7517' : '#A32D2D';
    const card = '<div class="oglas-card" onclick="window.open(\'https://www.olx.ba/\' + \'' + o.link + '\', \'_blank\')">' +
        '<div class="oglas-slika">' + o.emoji + '</div>' +
        '<div class="oglas-body">' +
        '<div class="oglas-naslov">' + o.naslov + '</div>' +
        '<div class="oglas-cijena">' + o.cijenaStr + '</div>' +
        '<div class="oglas-meta"><span class="oglas-lokacija">' + o.lokacija + ' · ' + o.datum + '</span>' +
        '<span class="oglas-platforma platforma-' + o.platforma + '">' + o.platforma.toUpperCase() + '</span></div>' +
        '<div class="ai-score"><span class="ai-tag ai-' + o.aiTag + '">' + o.aiLabel + '</span>' +
        '<div class="score-bar-wrap"><div class="score-bar-fill" style="width:' + o.score + '%;background:' + scoreColor + ';"></div></div>' +
        '<span class="score-label" style="color:' + scoreColor + ';">' + o.score + '</span></div>' +
        '</div></div>';
    return card;
}).join('');
}

function pretrazi() {
    const query = document.getElementById('searchInput').value.toLowerCase().trim();
    
    let filtrirani = [...demoOglasi];
    
    if (query) {
        filtrirani = filtrirani.filter(o => 
            o.naslov.toLowerCase().includes(query) ||
            o.lokacija.toLowerCase().includes(query)
        );
    }

    if (aktivnaPlatforma !== 'sve') {
        filtrirani = filtrirani.filter(o => o.platforma === aktivnaPlatforma);
    }

    primijeniSortiranje(filtrirani);
}

function filterPlatforma(btn, platforma) {
    document.querySelectorAll('.filter-btn').forEach(b => {
        if (['sve','olx','njuskalo','facebook'].some(p => b.onclick?.toString().includes(p))) {
            b.classList.remove('active');
        }
    });
    btn.classList.add('active');
    aktivnaPlatforma = platforma;
    pretrazi();
}

function sortiraj(btn, tip) {
    document.querySelectorAll('.filter-btn').forEach(b => {
        if (['novo','cijena_asc','cijena_desc','score'].some(s => b.onclick?.toString().includes(s))) {
            b.classList.remove('active');
        }
    });
    btn.classList.add('active');
    aktivnoSortiranje = tip;
    pretrazi();
}

function primijeniSortiranje(oglasi) {
    switch(aktivnoSortiranje) {
        case 'cijena_asc':
            oglasi.sort((a, b) => a.cijena - b.cijena);
            break;
        case 'cijena_desc':
            oglasi.sort((a, b) => b.cijena - a.cijena);
            break;
        case 'score':
            oglasi.sort((a, b) => b.score - a.score);
            break;
        default:
            break;
    }
    prikaziOglase(oglasi);
}

// Ucitavamo oglase kad se stranica otvori
async function pretraziOLX(query) {
    const grid = document.getElementById('oglasiGrid');
    const info = document.getElementById('rezultatiInfo');
    grid.innerHTML = '<div class="loader">Pretrazujem OLX...</div>';
    
    const res = await fetch('/api/oglasi?q=' + encodeURIComponent(query));
    const data = await res.json();
    
    if (!data.data || data.data.length === 0) {
        grid.innerHTML = '<div class="loader">Nema rezultata.</div>';
        return;
    }

    info.textContent = 'Pronadeno ' + data.data.length + ' oglasa na OLX.ba';
    
    grid.innerHTML = data.data.map(o => {
        const cijena = o.display_price || 'Na upit';
        const slika = o.images && o.images[0] ? o.images[0] : null;
        const grad = o.cities && o.cities[0] ? o.cities[0].name : '';
        
        return '<div class="oglas-card" onclick="window.open(\'https://www.olx.ba/oglas/' + o.slug + '\', \'_blank\')">' +
            '<div class="oglas-slika">' + (slika ? '<img src="' + slika + '" style="width:100%;height:100%;object-fit:cover;">' : '') + '</div>' +
            '<div class="oglas-body">' +
            '<div class="oglas-naslov">' + o.title + '</div>' +
            '<div class="oglas-cijena">' + cijena + '</div>' +
            '<div class="oglas-meta"><span class="oglas-lokacija">' + grad + '</span>' +
            '<span class="oglas-platforma platforma-olx">OLX</span></div>' +
            '</div></div>';
    }).join('');
}

function pretrazi() {
    const query = document.getElementById('searchInput').value.trim();
    if (!query) return;
    window.open('https://www.olx.ba/pretraga?keywords=' + encodeURIComponent(query), '_blank');
}

window.onload = () => prikaziOglase(demoOglasi);

document.addEventListener('keydown', e => {
    if (e.key === 'Enter') pretrazi();
});