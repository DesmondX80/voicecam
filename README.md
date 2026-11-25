# voicecam

Camera with voice commands: kuvaa golflyönti puhelimella äänikomennoilla ja vie video analysointisovellukseen.

Selainsovellus (PWA), joka toimii Androidilla (Chrome) ja iPhonella (Safari) ilman asennusta.

## Android-sovellus (APK)

`npm run apk` rakentaa tiedoston `voicecam.apk` (Capacitor, debug-allekirjoitus).
Asenna se siirtämällä tiedosto puhelimeen ja avaamalla se, tai komennolla `adb install voicecam.apk`.
Puhelin kysyy lupaa asentaa tuntemattomasta lähteestä.

APK:ssa puheentunnistus käyttää Androidin omaa tunnistinta, ja jakaminen käyttää natiivia jakovalikkoa.
**Tallenna laitteelle** tallentaa videon kansioon `Documents/VoiceCam/`.

Vaatii Java 21:n ja Android SDK:n (`ANDROID_HOME`). Kun web-koodia (`www/`) muutetaan, aja `npm run apk` uudelleen.

## Asennus puhelimeen (PWA)

Sovellus on asennettava PWA. Se asentuu aloitusnäytölle omalla kuvakkeella, avautuu koko näytölle
ilman selaimen palkkeja ja toimii ilman verkkoa (puheentunnistus vaatii yleensä verkon).

- **Android (Chrome):** avaa sivu ja paina **Asenna sovellus**, tai valitse valikosta (⋮) **Asenna sovellus**.
- **iPhone (Safari):** avaa sivu, paina **Jaa** ⬆︎ ja valitse **Lisää Koti-valikkoon**.

Sivun pitää tulla HTTPS-osoitteesta (katso Kehitys).

## Käyttö

1. Avaa sivu puhelimella **HTTPS**-osoitteesta ja paina **Käynnistä kamera**.
2. Aseta puhelin jalustalle ja kävele lyöntipaikalle.
3. Sano **"aloita"**, jolloin tallennus alkaa ja kuuluu korkea piippaus.
4. Lyö. Sano **"lopeta"** (matala piippaus), tai anna tallennuksen pysähtyä maksimipituuden jälkeen (oletus 10 s).
5. Paina **Jaa analyysisovellukseen**, jolloin puhelimen jakovalikko avautuu ja video menee mihin tahansa
   analysointisovellukseen. Toinen vaihtoehto on **Tallenna laitteelle**. Sano **"uusi"** seuraavaa lyöntiä varten.

| Toiminto | Komennot |
|---|---|
| Aloita | aloita, kuvaa, nauhoita, tallenna, start, record |
| Lopeta | lopeta, stop, seis, valmis |
| Uusi lyönti | uusi, uudestaan, again |

Asetuksissa voi valita kielen (fi/en), maksimipituuden, aloitusviiveen ja äänen tallennuksen.

## Kehitys

Web-sovellus on kansiossa `www/` ilman build-vaihetta: `index.html`, `app.js`, `style.css`, `sw.js` (service worker / offline),
`manifest.webmanifest` ja `icons/`. Kun tiedostoja muutetaan, kasvata `CACHE`-versiota `sw.js`:ssä.

Kamera ja mikrofoni vaativat suojatun yhteyden, joten puhelimella sivu pitää avata HTTPS:n kautta, esim.
GitHub Pagesista tai `npx localtunnel --port 8000` / `cloudflared tunnel --url http://localhost:8000`
-tunnelin kautta:

```sh
python3 -m http.server 8000 --directory www
```

## Tunnetut rajoitukset

- Video tallennetaan ilman ääntä oletuksena, koska samanaikainen äänitallennus voi viedä mikrofonin puheentunnistukselta.
- iOS tallentaa MP4:ää. Android Chrome tallentaa MP4:ää uusissa versioissa ja muuten WebM:ää, jota
  kaikki analysointisovellukset eivät avaa.
- Kuvanopeus riippuu selaimesta ja laitteesta (pyydetään 60 fps). Selain ei pääse puhelimen
  hidastusvideotilaan (120/240 fps).
- Puheentunnistus vaatii yleensä verkkoyhteyden.
