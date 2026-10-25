# 🏀 Estadísticas de Básquet

App web para sacar las estadísticas de un partido de baloncesto a partir del vídeo completo.
La inteligencia artificial de Google (Gemini) ve el partido y apunta cada jugada; la app calcula las estadísticas y escribe el informe.

## Qué te da

- **Marcador y tabla de estadísticas** por jugador y por equipo: puntos, tiros de 2, triples, tiros libres, % de acierto, rebotes (ofensivos y defensivos), asistencias, robos, tapones, pérdidas, faltas y valoración.
- **Explicación de cada número.**
- **Resumen del partido**, lo que se hizo bien, lo que hay que mejorar y el jugador destacado.
- **Momentos clave** con el minuto del vídeo.
- **Evolución del marcador** en un gráfico.
- **Revisión de jugadas**: lista de todo lo detectado, con un clic vas a ese momento del vídeo y puedes corregir el jugador o el tipo de jugada.
- Descargar la tabla para Excel, imprimir o guardar el informe en PDF, y guardar el partido para abrirlo otro día.

## Cómo se usa

1. **Ajustes**: pega tu clave de Gemini. Se consigue gratis en <https://aistudio.google.com/apikey>.
2. **Partido**: elige el vídeo, escribe los nombres y el color de camiseta de los dos equipos y, si quieres, la lista de jugadores (`dorsal - nombre`).
3. Pulsa **Analizar partido**. El vídeo se sube a Google y se analiza por tramos de 5 minutos. Un partido entero tarda unos 15–30 minutos.
4. **Revisar jugadas**: corrige lo que esté mal. Las jugadas dudosas salen en amarillo.
5. **Informe**: ya está todo. Si has corregido mucho, pulsa "Rehacer resumen".

## Límites

- La IA acierta bastante con las estadísticas de equipo. Para las de cada jugador hace falta que se lean los dorsales: cuanto mejor sea la grabación (cámara fija, alta, que se vea toda la pista), mejor.
- Asistencias, robos y rebotes son las jugadas que más se escapan. Para eso está la pestaña de revisión.
- Con la clave gratuita hay un límite de uso diario, y Google puede usar los vídeos para mejorar sus modelos. Si eso te preocupa (por ejemplo, con menores), activa la facturación en Google AI Studio.

## Detalles técnicos

La app es HTML y JavaScript sin servidor (`index.html`, `app.js`, `analisis.js`, `gemini.js`, `stats.js`, `styles.css`). Se puede publicar tal cual en GitHub Pages.
La clave de Gemini y los análisis solo se guardan en el navegador de quien la usa.
