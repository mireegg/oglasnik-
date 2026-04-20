const demoOglasi = [
    {
        id: 1,
        naslov: 'VW Golf 7 GTI 2013 DSG 169kw 230ks Automatik Performance',
        cijena: 25900,
        cijenaStr: '25.900 KM',
        lokacija: 'BiH',
        platforma: 'olx',
        emoji: '🚗',
        score: 72,
        aiTag: 'warn',
        aiLabel: 'Visoka kilometraza',
        datum: 'danas',
        detalji: 'Benzin, 2013g, 242.600km, 2.0 benzin 169kw/230ks, DSG automatik, crna boja, GTI Performance, xenon/LED, Dynaudio ozvucenje, dvozonska klima, navigacija, grijanje sjedista, sportski ovjes, servisna knjiga, euro6, registrovan do 10/2026'
    },
    {
        id: 2,
        naslov: 'VW Golf 7.5 1.6 TDI 85kw DSG SOUND 2017/2018',
        cijena: 23999,
        cijenaStr: '23.999 KM',
        lokacija: 'BiH',
        platforma: 'olx',
        emoji: '🚗',
        score: 65,
        aiTag: 'warn',
        aiLabel: 'Visoka kilometraza',
        datum: 'danas',
        detalji: 'Dizel, 2017g/2018 reg, 218.000km, 1.6 TDI 85kw, DSG automatik, crna boja, SOUND paket, LED svjetla, dvozonska klima, navigacija, grijanje sjedista, parking senzori, tempomat, servisna knjiga, 1 vlasnik, placeno sve do registracije, euro6'
    },
    {
        id: 3,
        naslov: 'VW Golf 7 2.0 TDI 110kw 150ks DSG CUP 2014/2015 Uvoz DE',
        cijena: 24999,
        cijenaStr: '24.999 KM',
        lokacija: 'BiH',
        platforma: 'olx',
        emoji: '🚗',
        score: 88,
        aiTag: 'good',
        aiLabel: 'Odlicna ponuda',
        datum: '25.03.2026',
        detalji: 'Dizel, 2014g/2015 reg, 175.680km, 2.0 TDI 110kw/150ks, DSG automatik, crna boja, CUP paket, bixenon farovi, dvozonska klima, navigacija, grijanje sjedista, adaptivni tempomat, front assist, line assist, parking senzori naprijed i nazad, servisna knjiga digitalna, veliki servis uradjen, 1 vlasnik, uvoz iz Njemacke, placeno sve do registracije, euro6, garancija na papire i km'
    },
    {
        id: 4,
        naslov: 'VW Golf 7 2.0 TDI 110kw DSG Bi-Xenon LED Navigacija Highline 2013',
        cijena: 19550,
        cijenaStr: '19.550 KM',
        lokacija: 'BiH',
        platforma: 'olx',
        emoji: '🚗',
        score: 55,
        aiTag: 'warn',
        aiLabel: 'Visoka kilometraza',
        datum: '04.04.2026',
        detalji: 'Dizel, 2013g, 258.000km, 2.0 TDI 110kw, DSG automatik, crna boja, Highline oprema, xenon farovi, dvozonska klima, navigacija, grijanje i hladjenje sjedista, masaza sjedista, memorija sjedista, parking kamera i senzori, carplay, senzor mrtvog ugla, 2 vlasnika, zimske gume, euro5'
    },
    {
        id: 5,
        naslov: 'VW Golf 7 Bluemotion 1.6 TDI 81kw DSG 2015',
        cijena: 20800,
        cijenaStr: '20.800 KM',
        lokacija: 'BiH',
        platforma: 'olx',
        emoji: '🚗',
        score: 45,
        aiTag: 'warn',
        aiLabel: 'Jako visoka kilometraza',
        datum: '08.04.2026',
        detalji: 'Dizel, 2015g, 273.497km, 1.6 TDI 81kw/110ks, DSG automatik, crna boja, Bluemotion, halogena svjetla, dvozonska klima, navigacija, grijanje sjedista, parking senzori, tempomat, senzor mrtvog ugla, ljetne gume, klasicni ovjes'
    }
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