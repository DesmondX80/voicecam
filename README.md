# voicecam

Camera with voice commands: kuvaa video puhelimella äänikomennoilla ja jaa se muihin sovelluksiin.

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
2. Aseta puhelin jalustalle ja siirry kuvattavaksi.
3. Sano **"aloita"**, jolloin tallennus alkaa ja kuuluu korkea piippaus.
4. Sano **"lopeta"** (matala piippaus), tai anna tallennuksen pysähtyä maksimipituuden jälkeen (oletus 10 s).
5. Paina **Jaa**, jolloin puhelimen jakovalikko avautuu ja video menee mihin tahansa sovellukseen.
   Toinen vaihtoehto on **Tallenna laitteelle**. Sano **"aloita"** tai paina tallennusnappia, niin uusi tallenne alkaa.

| Toiminto | Komennot |
|---|---|
| Aloita | aloita, kuvaa, nauhoita, tallenna, start, record |
| Lopeta | lopeta, stop, seis, valmis |
| Takaisin kameraan | uusi, uudestaan, again |
| Vaihda etu-/takakamera | vaihda, käännä, switch, flip |

Asetuksissa voi valita kielen (fi/en), maksimipituuden, aloitusviiveen ja äänen tallennuksen.

## Kuvanopeus (paras = suurin fps)

APK lukee käynnistyessään laitteen kameroiden tilat (`HighSpeedCamPlugin.java`) ja valitsee aina suurimman fps:n
(tasatilanteessa suurempi resoluutio, sitten pääkamera ennen laajakulmaa). Asetuksista voi valita tilan myös käsin.

- **Hidastustilat** (Camera2 constrained high-speed, esim. 720p 120/240/480 fps): esikatselu ja tallennus natiivisti,
  esikatselu läpinäkyvän WebView:n alla. Video tallentuu todellisella nopeudella; ääni MicSharelta.
- **Tavalliset tilat**: selainkamera (getUserMedia) laitteen suurimmalla tavallisella nopeudella (esim. 60 fps).
- Esim. moto g86 power: 720p 120 fps (laajakulma), pääkamera 60 fps. Selainversio käyttää aina selainkameraa.

## Golf swing -tila

Asetuksista päälle kytkettävä tila, joka leikkaa videon lyönnin mukaan (`www/swing.js`):

- Tallennuksen aikana esikatselusta mitataan liike (muuttuneiden pikselien osuus, 96 px leveä harmaasävykuva).
- Suurin liikepiikki = alaswing/osuma. Siitä taaksepäin haetaan ≥ 0,5 s paikallaanolo = **aloitusasento**;
  lyönti alkaa, kun liike lähtee siitä. Eteenpäin haetaan loppuasennon pysähtyminen.
- Leike: 1 s ennen lyönnin alkua → 1 s loppuasennon jälkeen, kuitenkin ennen **lopeta-komentoa**
  (natiivi tunnistin kertoo puheen alkuhetken; muuten arvio 1,3 s ennen tunnistusta).
  Lopeta-komento leikataan pois myös tavallisista tallennuksista.
- Leikkaus ilman uudelleenpakkausta: näytteet karsitaan avainkuvan tarkkuudella (golf-tilassa avainkuva 0,5 s välein)
  ja tarkka kohta merkitään MP4:n edit listiin.
- Kamera jalustalle: tunnistus olettaa, että kuvassa liikkuu vain lyöjä.

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

- Android antaa mikrofonin vain yhdelle kaappaajalle kerrallaan. Asetuksen **Ääni** vaihtoehdot:
  - **Ääni + äänikomennot** (APK, Android 13+, oletus): oma natiivi plugin (`MicSharePlugin.java`) nauhoittaa
    mikrofonia, pakkaa äänen AAC:ksi ja syöttää saman äänen puheentunnistimelle (`EXTRA_AUDIO_SOURCE`).
    Ääni liitetään videoon tallennuksen jälkeen (`www/mp4fix.js`).
  - **Ääni – lopetus napista / ajastimella**: selaimen mikrofoni videolle; "lopeta" ei kuulu tallennuksen aikana.
  - **Ei ääntä**: kaikki äänikomennot toimivat (oletus selaimessa).
- MediaRecorderin pilkottu MP4 muunnetaan tallennuksen jälkeen tavalliseksi MP4:ksi (`www/mp4fix.js`), jotta kesto on oikein ja toisto ei takkua lopussa.
- iOS tallentaa MP4:ää. Android Chrome tallentaa MP4:ää uusissa versioissa ja muuten WebM:ää, jota
  kaikki sovellukset eivät avaa.
- Kuvanopeus riippuu selaimesta ja laitteesta (pyydetään 60 fps). Selain ei pääse puhelimen
  hidastusvideotilaan (120/240 fps).
- Puheentunnistus vaatii yleensä verkkoyhteyden.
