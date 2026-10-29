# Informatica in Classe

Libro di informatica interattivo, diviso in sezioni contrassegnate da colore e simbolo per classe.
È una pagina statica: non serve nessun server.

## Struttura

- `src/content.txt`: tutti i contenuti (capitoli e sezioni).
- `src/template.html`: grafica e funzioni della pagina.
- `src/pyrun.js`: l'interprete Python usato dall'editor della sezione «Laboratorio» (nessuna libreria esterna).
- `build.py`: unisce i file e crea `dist/index.html`.
- `allegati/`: i file delle lezioni (slides in PDF, schede, esercizi).
- `dist/index.html`: il sito pronto da pubblicare.
- `netlify.toml`: impostazioni per Netlify.

## Pubblicare su GitHub

1. Crea un repository vuoto su github.com.
2. Dalla cartella del progetto:

```bash
git init
git add .
git commit -m "Primo invio"
git branch -M main
git remote add origin https://github.com/NOME-UTENTE/NOME-REPOSITORY.git
git push -u origin main
```

## Pubblicare su Netlify

Con GitHub (consigliato, si aggiorna a ogni modifica):
1. Su app.netlify.com scegli "Add new site", poi "Import an existing project", poi GitHub.
2. Seleziona il repository. Netlify legge `netlify.toml`: comando `python3 build.py`, cartella `dist`.
3. Premi "Deploy".

Senza GitHub: trascina la cartella `dist` su app.netlify.com/drop.

## Come si modificano i contenuti

- **Dal file**: modifica `src/content.txt`, esegui `python3 build.py`, fai commit e push. Netlify ripubblica da solo.
- **Dal browser**: sul sito premi "Modifica". Le modifiche restano nel browser di chi le fa e non sono condivise.
  Per portarle nel sito, premi "Esporta sorgente per GitHub", sostituisci `src/content.txt` con il file scaricato e fai commit.

## Slides e allegati di ogni lezione

Nell'editor di una sezione c'è il blocco "Slides e allegati della lezione". Per ogni materiale si sceglie il tipo
(Slides, Allegato, Link o video), un titolo e un indirizzo:

- un indirizzo completo, per esempio quello di Google Slides, PowerPoint online, YouTube o un PDF online;
- oppure `allegati/nome-file.pdf`, per un file messo nella cartella `allegati/` del progetto.
  Dopo aver aggiunto il file, fai commit e push: `build.py` lo copia nel sito.

I materiali si aprono in una nuova scheda. I file nella cartella `allegati/` funzionano solo sul sito pubblicato.

## Formato di `src/content.txt`

```
@@chapter c1 | 1 | Titolo del capitolo | Descrizione breve
@@section s1-1 | P1 T1 Q1 | - | Titolo della sezione
Testo della sezione...
```

Sotto `@@section` si possono aggiungere righe `@@material tipo | titolo | indirizzo` (tipo: `slides`, `file`, `link`).

Dopo `@@section`: identificativo, classi (P1, T1, Q1, L2, L3, L4), strumento interattivo
(`converter`, `textbin`, `rgb`, `cpu`, `flow` oppure `-` per nessuno), titolo.
Nel testo: `## Sottotitolo`, `**grassetto**`, `` `codice` ``, elenchi con `- `, tabelle con `|`,
box con `> [Fisica] testo`, domande con `?? domanda` e `!! risposta`,
codice tra righe ``` ```python ```, risultati tra righe ``` ```output ```.

## L'editor Python nel libro

La sezione «Laboratorio: prova il codice Python qui» (3ª e 4ª liceo) contiene un editor che esegue il codice nel browser,
senza server e senza installare nulla. Il codice è in `src/pyrun.js`: è un interprete scritto per questo libro, non il Python ufficiale.

- Moduli disponibili: `math`, `random`, `statistics`, `time`, `json`, `copy`.
- Non disponibili: `numpy`, `scipy`, `matplotlib`, `pandas`, file, `sqlite3`, `with`, generatori.
- `random` non produce gli stessi numeri di Python sul computer; la ricorsione arriva a circa 350 livelli.
- Per aggiungere l'editor a un'altra sezione: nell'editor della sezione scegli lo strumento «Editor Python eseguibile»,
  oppure in `content.txt` scrivi `pyrun` al posto del trattino nell'intestazione `@@section`. Una sezione ha un solo strumento.
- Gli esempi del menu si modificano nell'array `PY_PRESETS` di `src/template.html`.
