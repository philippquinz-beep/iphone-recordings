# Diktat

Ein Diktiergerät als installierbare Web-App (PWA). Die Aufnahmen liegen
ausschließlich lokal auf dem Gerät (IndexedDB) — es gibt keinen Server,
keinen Upload und kein Benutzerkonto.

## Bedienung

Ein vierstufiger Schieberegler, von oben nach unten:

| Stufe | Symbol | Verhalten |
|---|---|---|
| Aufnehmen | Kreis | rastet ein, nimmt ab der aktuellen Stelle auf |
| Stopp | Viereck | rastet ein, Grundstellung |
| Abspielen | Dreieck rechts | rastet ein |
| Zurückspulen | zwei Dreiecke links | **gedrückt halten**; beim Loslassen springt der Regler auf Abspielen |

Beim Zurückspulen wird das aufgenommene Audio rückwärts mit doppelter
Geschwindigkeit ausgegeben. Wird der Regler an einer beliebigen Stelle auf
Aufnehmen geschoben, überschreibt die neue Aufnahme ab dort das vorhandene
Material; alles hinter der neu aufgenommenen Passage bleibt erhalten.

Am PC zusätzlich per Tastatur: `↑` `↓` wechseln die Stufe, `Leertaste`
schaltet zwischen Abspielen und Stopp, `←` gedrückt halten spult zurück.

## Lokal testen

```bash
python serve.py
```

Dann `http://localhost:8080` öffnen. `localhost` gilt als sicherer Kontext,
deshalb funktionieren Mikrofon, Service Worker und Installation auch ohne
HTTPS.

## Auf GitHub Pages veröffentlichen

Repository anlegen, pushen und in den Repository-Einstellungen unter
*Pages* als Quelle den Branch `main` mit Ordner `/ (root)` wählen. Die App
ist dann unter `https://<benutzer>.github.io/<repo>/` erreichbar.

Am iPhone in Safari öffnen, Teilen-Symbol → *Zum Home-Bildschirm*. Danach
startet die App im Vollbild mit eigenem Icon.

## Technik

| Datei | Inhalt |
|---|---|
| `js/audio.js` | Tonspur, Aufnahme, Wiedergabe, Rückwärtslauf |
| `js/recorder-worklet.js` | Mikrofon-Abgriff als rohes PCM |
| `js/db.js` | IndexedDB, blockweises Speichern |
| `js/wav.js` | WAV-Export |
| `js/app.js` | Oberfläche und Schieberegler |

Aufgenommen wird unkomprimiertes PCM (16 Bit, Mono, möglichst 24 kHz).
Nur damit lässt sich ab einer beliebigen Stelle sauber überschreiben.
Das ergibt rund **2,9 MB pro Minute**. Die Daten werden in Blöcken von
10 Sekunden abgelegt, sodass beim Speichern nur geänderte Blöcke
geschrieben werden; zusätzlich wird während der Aufnahme alle 10 Sekunden
automatisch gesichert.

## Grenzen unter iOS

- Wird der Bildschirm gesperrt oder die App in den Hintergrund gelegt,
  pausiert iOS das Mikrofon. Die App stoppt die Aufnahme dann selbst und
  sichert das Bisherige. Während Aufnahme und Wiedergabe wird der
  Bildschirm nach Möglichkeit wach gehalten (Wake Lock).
- Safari kann Daten von Webseiten unter Speicherdruck löschen. Als
  installierte PWA ist das deutlich unwahrscheinlicher, aber nicht
  ausgeschlossen — wichtige Diktate über den Export als WAV sichern.
- Solange aufgenommen wird, zeigt iOS die Mikrofon-Anzeige. Das Mikrofon
  wird freigegeben, sobald die Liste wieder geöffnet wird.
