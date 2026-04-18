async function prijava() {
    // Uzimamo vrijednosti iz forme
    const ime = document.getElementById('ime').value;
    const email = document.getElementById('email').value;
    const telefon = document.getElementById('telefon').value;
    const poruka = document.getElementById('poruka');

    // Provjera da li je korisnik popunio sva polja
    if (!ime || !email || !telefon) {
        poruka.style.color = 'red';
        poruka.textContent = 'Molimo popunite sva polja!';
        return;
    }

    // Šaljemo podatke na server
    const odgovor = await fetch('/prijava', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ime, email, telefon })
    });

    const rezultat = await odgovor.json();

    if (rezultat.uspjeh) {
        poruka.style.color = '#1D9E75';
        poruka.textContent = '✅ Uspješno ste se prijavili! Kontaktirat ćemo vas uskoro.';
    } else {
        poruka.style.color = 'red';
        poruka.textContent = '❌ Došlo je do greške, pokušajte ponovo.';
    }
}