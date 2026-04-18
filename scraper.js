const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

async function skupiOglase() {
    console.log('Pokrecem scraper...');
    
    const browser = await puppeteer.launch({ 
        headless: false,
        args: ['--no-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    console.log('Idemo na OLX...');
    await page.goto('https://www.olx.ba/pretraga?keywords=golf&kategorija=Automobili', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
    });

    await new Promise(r => setTimeout(r, 5000));

    // Klikamo SLAZEM SE dugme
    try {
        await page.evaluate(() => {
            const dugmad = Array.from(document.querySelectorAll('button'));
            const dugme = dugmad.find(d => d.innerText.trim() === 'SLAZEM SE' || d.innerText.trim() === 'SLAŽEM SE');
            if (dugme) dugme.click();
        });
        console.log('Kliknuo na SLAZEM SE!');
    } catch(e) {
        console.log('Greska sa popupom:', e.message);
    }

    // Cekamo da se oglasi ucitaju nakon zatvaranja popupa
    await new Promise(r => setTimeout(r, 6000));

    const oglasi = await page.evaluate(() => {
        const lista = [];
        const elementi = document.querySelectorAll('a[data-v-0598c353]');
        
        elementi.forEach(el => {
            const tekst = el.innerText.split('\n').filter(t => t.trim() !== '');
            if (tekst.length < 3) return;

            const cijena = tekst.find(t => t.includes('KM') || t.includes('Na upit'));
            const naslov = tekst.find(t => t.length > 10 && !t.includes('KM') && !t.includes('Izdvojeno') && !t.includes('OLX') && !t.includes('Novo') && !t.includes('Korišteno'));
            const link = el.href;
            
            if (naslov && cijena && link.includes('/oglas/')) {
                lista.push({ naslov, cijena, link });
            }
        });
        
        return lista;
    });
    
    console.log(`Pronasao ${oglasi.length} oglasa!`);
    oglasi.slice(0, 5).forEach(o => console.log(`- ${o.naslov} | ${o.cijena}`));
    
    fs.writeFileSync('oglasi.json', JSON.stringify(oglasi, null, 2));
    console.log('Sacuvano u oglasi.json!');

    await browser.close();
}

skupiOglase();