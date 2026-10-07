# Nómina: una pantalla que se puede mirar

## Objective

Que la pantalla de nómina deje de ser el módulo entero en una vista. Hoy tiene **cuatro secciones de
nivel superior**, cuatro sub-secciones dentro del detalle y **30 referencias a diálogos** en un
archivo de **3.847 líneas**; de esas cosas, sólo dos son operación diaria.

Lo que se opera todos los días: **el aviso de pendientes y la lista de períodos**. Todo lo demás
—lo que se declara una vez, lo que se hace por excepción y lo que se consulta— sale de esa vista.

## Decisión del dueño (2026-10-06)

1. **La declaración del anclaje pasa a ser un paso del diálogo «Abrir período»**, no una sección.
   Cero superficie nueva: aparece cuando importa y no ocupa lugar el resto del tiempo.
2. **«Pagos extraordinarios» sale de la vista principal como un BOTÓN** en el encabezado de nómina,
   que abre el diálogo que ya existe. Es una ACCIÓN de excepción (despido, renuncia, emergencia), no
   algo que se mire a diario.
3. **«Pagos del mes por empleado» sale a una pestaña propia** dentro de la pantalla
   (`Períodos | Pagos del mes`). Es una CONSULTA: no se opera desde ahí.

**Nada se borra**: las tres cosas siguen existiendo, en otro lugar. La decisión fue sobre la
ubicación, no sobre el alcance.

## El inventario medido (2026-10-06)

| Qué | Dónde | ¿Es operación diaria? |
| --- | --- | --- |
| **Períodos** (aviso, lista, pestañas por cadencia, abrir período) | `payroll-client.tsx:2571` | **Sí** |
| **Anclaje por cadencia** | `:2728` | No: se declara una vez por cadencia |
| **Pagos extraordinarios** | `:2839` | No: excepción |
| **Pagos del mes por empleado** | `:2913` | No: consulta |
| Dentro del detalle: **Ajuste del mixto**, **Facturas de la liquidación**, **Vales de la liquidación** | `:1102`, `:1113`, `:1183` | Sí, pero **dentro del detalle del período**: ahí están bien |

## Por qué pasó (y es del proyecto, no del dueño)

El módulo retiró la capa de plataforma —que era donde vivía la fecha de arranque de la nómina— y
**quedó sin ningún lugar donde poner configuración de nómina**. Cada cosa nueva se apiló entonces en
la pantalla de operación: el anclaje (2026-10-06) fue el cuarto piso. La limpieza no es cosmética:
es el estado al que lleva una configuración sin casa.

## Diseño

### La vista principal, después

- El aviso de ciclos pendientes.
- La lista de períodos con sus pestañas por cadencia.
- El botón «Abrir período».
- El botón **«Pago extraordinario»** (acción de excepción, abre el diálogo de hoy).
- La pestaña **«Pagos del mes»** (la consulta, con su contenido tal cual).

### El paso del anclaje, dentro de «Abrir período»

Se rinde **sólo cuando corresponde**, y las dos condiciones son distintas:

1. **La primera liquidación de una cadencia sin anclaje declarado**: se pregunta
   «¿Hasta qué día se pagaron los sueldos de este grupo?», con la vista previa de a qué sábado se
   ajusta y **cuántos días absorbe** (decisión 1 del anclaje: no esconderlo).
2. **El ciclo elegido está cubierto** (total o parcialmente) por el anclaje declarado: se dice
   hasta qué día está declarado pagado, y —si está parcialmente cubierto— el rango que sí se va a
   liquidar.

Con el anclaje ya declarado y un ciclo no cubierto, **el paso no aparece**: no hay nada que
preguntar. Y si esa cadencia ya tiene períodos, se dice que la declaración está cerrada en vez de
ofrecer un campo que el servicio va a rechazar.

### Lo que hay que cuidar

- **El diálogo se agranda.** Es el riesgo real de esta decisión: el paso tiene que ser condicional
  (arriba) y corto, o cambiamos una pantalla cargada por un diálogo cargado.
- **Las guardas de pantalla se mudan.** Las que hoy fijan la sección del anclaje son escaneos de
  texto en `tests/payroll.test.ts` (las que se escribieron para T5) y **van a dejar de encontrar lo
  que buscan**. Hay que repuntarlas a su nueva casa y **mantenerlas capaces de fallar**: una guarda
  que pasa siempre no es una guarda.
- **Los controles negativos sobreviven a la mudanza**: sin anclajes declarados, el aviso y la
  apertura se comportan como hoy. Que el anclaje cambie de lugar no puede cambiar una regla.

## Tareas

- [x] **T1** — El paso del anclaje dentro del diálogo, con sus dos condiciones y la vista previa. Se
      retira la sección de la vista principal.
      **HECHO** — commit `0ce1086`. `renderAnchorStep(frequency)` (`:2544-2638`, función que devuelve
      JSX y no un componente, por la misma razón que `renderPeriodList`: un componente declarado
      adentro es un tipo nuevo en cada render y remontaría el campo) se llama en `:3433-3442`,
      adentro del diálogo, con la condición `openAnchorDeclared === undefined || openCycleTouchesAnchor`
      (`:2300-2302`). Los tres estados, la vista previa con los días absorbidos, el aviso de la
      ventana de reparación y la condición de gente activa sobreviven sin cambiar una regla.
- [x] **T2** — «Pagos extraordinarios» como botón del encabezado; el diálogo, sin cambios.
      **HECHO** — botón `Pago extraordinario` junto a «Abrir período» (`:2837-2862`), que abre el
      diálogo de siempre.

      **Interpretación declarada (el dueño decide)**: la **tabla de pagos extraordinarios
      registrados** no podía quedarse en la vista principal (decisión 2) ni borrarse («nada se
      borra», y de ahí sale el llamado al servicio), así que se mudó **adentro del diálogo de la
      acción**. Eso modifica un diálogo que el brief pedía dejar intacto. Si el dueño prefiere verla
      en la pestaña «Pagos del mes», es una mudanza de una línea.
- [x] **T3** — «Pagos del mes por empleado» a la pestaña, con su contenido tal cual.
      **HECHO** — switch de vistas con la primitiva `Tabs` del archivo (`:2705-2736`), arranca en
      `periodos`, y el disparador de «Pagos del mes» va con `props.canAdmin` (si no, un empleado
      vería una pestaña cuyo panel nunca se rinde).
- [x] **T4** — Repuntar las guardas de pantalla a la nueva casa, endureciéndolas donde se pueda; y
      decir qué sigue sin poder probarse (el render es del dueño).
      **HECHO** — la guarda del anclaje se repuntó para fijar la **intención** y su capacidad de
      fallar se **probó por mutación**: borrar `{renderAnchorStep(openAnchorFrequency)}` la puso en
      rojo, y se restauró. Tiene control negativo (`not.toContain('>Anclaje por cadencia</h2>')`): la
      sección vieja no puede volver. **No existía ninguna guarda para las dos secciones retiradas**
      —`grep` de ambos nombres en `tests/` daba vacío—, así que la mudanza podía revertirse en
      silencio; se agregó una (T6) que fija el botón, la pestaña y los controles negativos de los
      títulos retirados.

**Compuerta**: 48 archivos / **2.497 pruebas**, `tsc` y `eslint` limpios.

**Lo que sigue sin poder probarse acá, y es el único eslabón**: **ninguna prueba renderiza esta
pantalla**. Lo verificado es la forma del código y el texto de las guardas; el switch de vistas, el
paso dentro del diálogo, el lugar del botón y la tabla adentro del diálogo los confirma el dueño en
el navegador. Tampoco se ejerce en ejecución el pareo ARIA de los tabs de nivel superior.

## Riesgos

- **El render no lo cubre ninguna prueba de este repo.** Lo estructural se fija con escaneos; lo
  visual lo confirma el dueño. La mudanza puede dejar algo visible que hoy no lo era, y eso sólo se
  ve en el navegador.
- **Descubrimiento**: mover una acción a un botón y una consulta a una pestaña tiene un costo de
  «dónde estaba esto». La pestaña se ve; el botón tiene que estar donde el ojo ya mira (el
  encabezado de la lista de períodos), no escondido en un menú.
- **Orden**: esta unidad toca `payroll-client.tsx`, el mismo archivo de la unidad del piso derivado
  de la primera factura. Va **después** de aquélla: dos escritores sobre el mismo archivo no.
