# Trigger System Design — `component:broke`

**Status:** proposta de design (sem implementação) — **revisão 3**. As 5 perguntas de decisão estão **resolvidas pelo usuário** (§10): centro = posição da entidade quebrou (Q1), gatilho sempre ativo (Q2), remoção + spill ao quebrar (Q3), **componentes internos FORA de escopo — descartados (Q4, confirmada na revisão 3)** e **sem clamp para a sala — nem no drop das facas nem no spill (Q5, confirmada na revisão 3)**. Requisito novo desta revisão: **quebra em cascata por dependência** (§3.6) — se um componente quebrado tem outros componentes **dependentes** dele, eles também quebram, **recursivamente**.

> **Nota (pós-implementação):** as seeds `humanDoll` (NPC), `humanLeg`/`humanFoot`/`humanToes` (blueprints/componentes) foram **removidas por decisão do usuário** ("esse npc nunca deveria existir"). A cascata de dependência é agora validada pelos componentes do droid existente (`smallBallDroid`, teste **Test 16**).
**Escopo:** novo sistema de gatilhos focado no evento "componente de entidade quebrou" (durabilidade cruza zero), com **remoção do componente quebrado do mundo — derramando (spill) todos os items e containers que estiverem dentro dele** (decisão do usuário, revisada) + **cascata de quebra por dependência** (revisão 3, §3.6) + gatilho de teste (3 facas em raio 5, **por evento**).

---

## 1. Problema

Hoje "quebra" não é um evento do mundo: quando `Physical.durability` cruza zero, nada é notificado além do re-cálculo de capacidades e do broadcast. Cada consumidor improvisa:

- A IA de NPC trata `durability < 1` como inutilizável (`BROKEN_DURABILITY_THRESHOLD = 1`) e re-seleciona alvo (`src/controllers/ai/NpcAIController.js:29`, `:439`).
- O contexto do LLM reporta a razão current/max (`src/controllers/networking/LlmContextController.js:488`).
- Não há clamp em lugar nenhum: durabilidade pode ficar profundamente negativa (estado documentado em `test/unit/NpcAIController.durabilityDesync.test.js`).

O mundo precisa de (a) um evento único e determinístico de quebra, e (b) um mecanismo para reagir a ele — o primeiro consumidor é a **remoção do componente quebrado, com derramamento (spill) do conteúdo no chão** (requisito do usuário, §3.5); o gatilho de teste (drop de 3 facas) é o segundo.

## 2. Mapa dos caminhos de quebra — por que um único ponto de coleta basta

Toda escrita de durabilidade do projeto funiliza em **exatamente dois mutators**, ambos com notificação existente:

| # | Caminho (como a quebra acontece) | Origem no código | Store escrita | Notificação existente |
|---|----------------------------------|------------------|---------------|------------------------|
| P1 | Combate, alvo único/`self` (ações `droid punch`, `cut`) | `damageComponent` consequence → `src/controllers/consequences/DamageConsequenceHandler.js:72` | stats do componente | listener de stat change |
| P2 | Combate, alvo `entity` (danifica **todos** os componentes do alvo) | `src/controllers/consequences/DamageConsequenceHandler.js:96` (`_damageEntityComponents`) | stats dos componentes | listener de stat change |
| P3 | Consequência genérica de stat (`dash` −5 durabilidade; `selfHeal` +10) | `src/controllers/consequences/StatConsequenceHandler.js:96`, `:122` (absoluto), `:142` (loop entity) | stats do componente | listener de stat change |
| P4 | Tiro de arma T1 (dano = volume do projétil consumido) | `src/controllers/consequences/ConsumeItemHandler.js:123` → delega ao mesmo handler de P1 | componente **ou** item equipado | listener / callback |
| P5 | Efeitos passivos por tick de componentes internos (hoje só reparo: +1 durab./5 ticks; o schema admite `amount` negativo → desgaste futuro) | `src/controllers/core/InternalComponentController.js:436` (`_applyTickEffect`), job registrado em `:46` | stats do **host** | listener de stat change |
| P6 | Holding cost no equip (ex.: faca: −2 durabilidade no host) | `src/controllers/core/HoldingCostController.js:265` | stats do host | listener de stat change |
| P7 | Restauração no unequip (inversão do delta; normalmente cura, mas pode ser negativo se o stat subiu durante o equip → quebra rara) | `src/controllers/core/HoldingCostController.js:347` | stats do host | listener de stat change |
| P8 | Dano em item equipado (ataque que mira `eqId`) | `src/controllers/consequences/DamageConsequenceHandler.js:54` (`equippedItemStats.updateStatDelta`) | stats do item equipado | callback de stat change |

Os dois mutators centrais:

- `ComponentController.updateComponentStat` / `updateComponentStatDelta` → `_notifyStatChangeListeners` (`src/controllers/core/componentController.js:53`, `:99`, `:121`).
- `EquippedItemStatsController.updateStat` / `updateStatDelta` → `_notifyStatChange` (`src/controllers/core/EquippedItemStatsController.js:263`).

Ambos os fluxos **já convergem no construtor da façade** (`src/controllers/WorldStateController.js:128` e `:151`), que hoje os usa para reavaliar capacidades e broadcast.

**Decisão central (single source of truth):** não emitir em cada handler, nem criar fios novos. O sistema de triggers é um **consumidor** das notificações existentes — exatamente o papel que o capability controller já ocupa. Qualquer escritor presente ou futuro (combate, tick, equip, T1, nova ação) dispara o evento automaticamente, sem tocar no writer.

**Componentes internos:** as instâncias de runtime não possuem stats mutáveis por instância (a instância é apenas id/type/host/installAt — [`src/controllers/core/InternalComponentController.js`](src/controllers/core/InternalComponentController.js:192)); só os stats do host sofrem os efeitos de tick. Logo, "componente interno quebra" **não existe hoje**: **decisão do usuário confirmada na revisão 3 — componentes internos estão FORA de escopo de forma definitiva** (Q4, §10): eles não quebram e **não participam da cascata de dependência** (§3.6); uma aresta `dependsOn` que aponte para um interno é ignorada sem crash (§6).

## 3. Design do sistema de triggers

### 3.1 Evento e semântica de disparo

- **Nome do evento:** `component:broke`.
- **Condição (cruzamento):** stat é `Physical.durability`, com `oldValue > 0` e `newValue <= 0`.
  - `>0 → <=0`: dispara **exatamente uma vez por quebra** — dano repetido em componente já quebrado (old ≤ 0) não re-dispara.
  - `<=0 → positivo` (reparo por `durabilityRepairSpheres`, restauração no unequip): **não** dispara (só cruzamento para baixo).
  - Consistente com o limiar já usado pela IA (quebrado = durability < 1).
- **Sem alterar a semântica do store:** o design não clampa durabilidade em 0 (manter o valor negativo é o estado documentado do projeto); o cruzamento é computado a partir dos old/new da notificação. Com a remoção (§3.5), o valor negativo não persiste no store: a instância de stats é eliminada no ato da quebra.

### 3.2 Onde a lógica vive — `TriggerController`

Novo **logic controller** (DI, sem auto-instantiação — padrão de `wiki/subMDs/controllers/controller_patterns.md` §4), no novo diretório `src/controllers/triggers/`:

- `on(event, handler)` / `off(event, handler)` — registro chaveado por nome de evento. **Por quê espelhar `ConsequenceHandlers`** (`src/controllers/consequences/consequenceHandlers.js`): o projeto já tem um dispatcher de "tipo → handler" para consequências; triggers são o análogo de "evento de engine → handler". Diferença: consequências são declaradas em data (`data/actions.json`); eventos de quebra são gerados pelo engine, então o registro de triggers vive em código, não em JSON.
- `handleComponentStatChange(componentId, traitId, statName, newValue, oldValue)` — chamado pelo listener de componentes **já existente** na façade. Em caso de cruzamento: resolve a entidade proprietária (escaneando a lista de entidades da façade — não existe lookup reverso componente→entidade; ver §5), monta o payload e emite.
- `handleEquippedItemStatChange(eqId, traitId, statName, newValue, oldValue)` — chamado pelo callback de item equipado **já existente** (a façade já resolve a entidade dona do eqId em `src/controllers/WorldStateController.js:151-166`).
- `emit(event, payload)` — executa handlers na ordem de registro, com isolamento de erro por handler (try/catch, espelhando o isolamento por-consequência de `src/controllers/consequences/ConsequenceDispatcher.js:378`): um handler quebrado não pode derrubar o pipeline de ações nem o tick.
- **Log de eventos:** o core registra cada cruzamento no `WorldEventLogController` (action `component:broke`, level `warn`, carimbado com o tick atual) — atende o requisito de que o trigger gere evento no log. O log alimenta o contexto do LLM e, por spec §4.7, não vai no broadcast.
- **Injeção:** construído na composition root (`src/composition/WorldComposition.js`), com façade injetada pós-construção (`setWorldStateController()`) e broadcaster (`setBroadcaster()`) — mesmo padrão de `InternalComponentController` e `TurnSystemController` (`src/controllers/core/TurnSystemController.js:113`).

### 3.3 Payload do `component:broke`

| Campo | Conteúdo |
|-------|----------|
| `event` | `component:broke` |
| `entityId` | entidade dona do componente quebrou (no caso de item equipado: a entidade que o equipa) |
| `roomId` | `location` da entidade quebrou |
| `position` | `spatial` da entidade — mesmo espaço de coordenadas dos dropped items (o pipeline compara os dois diretamente: `src/controllers/consequences/SpatialConsequenceHandler.js:70` e `src/controllers/consequences/PickUpItemHandler.js:90`) |
| `componentId` / `componentType` / `componentIdentifier` | o componente quebrou (no caso equipado: o host) |
| `kind` | `'component'` ou `'equipped-item'` — itens não são componentes neste projeto (o client os trata separadamente, `public/js/SelectionController.js:331`) |
| `eqId` / `itemType` | presentes quando `kind = 'equipped-item'` |
| `prevValue` / `value` | durabilidade antes e depois do cruzamento |
| `tick` | tick atual do mundo |

### 3.4 Fluxo (evento → trigger → handler)

```mermaid
flowchart TD
    A[Combate, dash, T1, tick, equip, unequip] --> B[Mutators de stat: ComponentController / EquippedItemStatsController]
    B --> C[Notificações já existentes: listener / callback de stat change]
    C --> D[Façade WorldStateController]
    D --> E[TriggerController: verificação de cruzamento, old > 0 e new <= 0, apenas Physical.durability]
    E -->|sem cruzamento| F[nada acontece]
    E -->|cruzamento| G[registro do evento no WorldEventLogController, level warn]
    G --> H[emit de component:broke com payload]
    H --> I[handlers registrados, com isolamento de erro]
    I --> I1[1º handler: BrokenComponentRemovalHandler — fase a spill, fase a½ cascata de dependência, fase b remover, fase c limpeza]
    I1 -->|dependente vivo: write 0 no mutator existente — re-entra neste mesmo funil| C
    I1 --> I2[2º handler: gatilho de teste — 3 facas por evento, raio 5, sem clamp]
    I2 --> K[helper compartilhado do DropItemHandler: grava dropped items — spill e facas]
    K --> L[batch único: broadcast world-state-update de fim do listener mais externo, via contador de reentrância]
    L --> M[client: componentes saem do painel; conteúdo derramado e facas no mapa espacial]
```

### 3.5 Handler built-in: remoção do componente quebrado (decisão do usuário — pergunta 3, revisada)

O usuário decidiu: **o componente é removido do mundo quando a durabilidade chega a zero**. A quebra deixa de ser um estado informativo: o que está quebrado sai do jogo. **Revisão (requisito novo):** todos os **items e containers que estiverem DENTRO do componente/instância destruída são DERRAMADOS no chão (spill)** — o conteúdo deixa de ser "perdido" e passa a ser jogável no mundo (recuperável por pickup). A remoção é o **primeiro** handler registrado em `component:broke` (antes do gatilho de teste): o drop de facas não depende do componente ainda presente, pois a posição do payload é capturada antes de qualquer handler executar, e a ordem de registro é determinística.

#### 3.5.1 Spill — drenagem do conteúdo (fase `a`, sempre primeira)

O inventário do projeto é **plano por entidade** (`entity.items` — `src/utils/InventoryManager.js:11`): cada item carrega `hostComponentId` = id do componente que o armazena **ou** id do item-container pai. Logo, "dentro do componente destruído" = items cujo `hostComponentId` aponta para o host destruído:

| `kind` no payload | Conteúdo drenado |
|-------------------|------------------|
| `component` | items com `hostComponentId === payload.componentId` (inventário do componente destruído) |
| `equipped-item` | items com `hostComponentId === payload.itemId` (inventário da instância do recipiente destruída) |

Enumeração via `InventoryManager.getContainerItems` (público, `src/utils/InventoryManager.js:697-699`) — mesma semântica de `getEntityItems` (`:251-266`). Para **cada** item drenado (N itens ⇒ N drops):

1. **Snapshot dos netos:** `_collectNestedItems(entity, itemId)` (`:492-511`) — cópia profunda da hierarquia interna;
2. **Posição própria:** amostragem uniforme no disco (§4.2) — raio 5, centro `payload.position` (= `entity.spatial`), sem clamp; cada item do spill sorteia sua própria posição;
3. **Gravação:** bloco extraído de `DropItemHandler` (`src/controllers/consequences/DropItemHandler.js:96-119`) → `droppedItems[id] = { itemType, itemId, x, y, roomId: payload.roomId, ownerId: payload.entityId, name, description, volume, nestedItems: <snapshot> }`;
4. **Remoção do inventário:** `InventoryManager.removeItem` (`:162`) direto na entidade ao vivo — nunca a API `removeItemFromEntity` da façade, que auto-broadcasteria (§3.5.3).

**Containers são dropados COMO containers** — a hierarquia interna viaja dentro do dropped item (`nestedItems`), **sem flatten**: exatamente as semânticas do drop manual (`DropItemHandler.js:82-87`) e do pickup que reconstrói a árvore via `addItemToContainer` (`src/controllers/consequences/PickUpItemHandler.js:136-158`). A drenagem é de **1 nível**: só o conteúdo direto do host destruído vira dropped item; sub-containers viajam dentro do `nestedItems` do respectivo pai (edge case §6).

**Regra inventário vs. equipamento (ambiguidade fechada):**
- (i) item com `hostComponentId` = host destruído → **spill** (se estiver equipado em *outro* host, desequipa antes — mesma semântica do drop manual, `DropItemHandler.js:62-67`);
- (ii) item equipado **no** host destruído mas *armazenado* em outro componente → **não** é conteúdo drenado: desequipado + removido na fase (b) (decisão anterior, mantida).

#### 3.5.2 Ordem exata da cascata: `(a) → (a½) → (b) → (c)`

| Fase | `kind = 'component'` | `kind = 'equipped-item'` |
|------|----------------------|--------------------------|
| **(a) drenar/spill** | Spill do conteúdo do componente (§3.5.1) | Spill do conteúdo da instância do recipiente (§3.5.1) |
| **(a½) cascata de dependência** (revisão 3, §3.6) | Forçar a quebra dos **dependentes** do componente quebrou (diretos e transitivos, via `dependsOn` de instância): pré-ordem com visited-set; cada dependente vivo emite o **próprio** `component:broke` (payload idêntico, §3.3) → executa a **própria** cadeia completa (a)→(a½)→(b)→(c) + suas próprias 3 facas, tudo dentro do contador de reentrância (§3.5.3) | **n/a** — item equipado não é nó da árvore de componentes (não tem dependentes); a cascata só se aplica a `kind = 'component'` |
| **(b) desequipar/remover** | (1) tirar do array `components[]` via novo `stateEntityController.removeComponent` (substituição por filter — §6); (2) desequipar (e remover, no-op se já derramada em (a)) o item equipado no host — a restauração do holding cost chega nos stats **ainda vivos** do host, que só morrem em (c); host já ≤ 0 ⇒ nenhum novo cruzamento | Desequipar (restauração do holding cost no host — `src/controllers/core/HoldingCostController.js:347`; a única que pode ser **negativa** → P7, §6) e remover a instância do item do inventário |
| **(c) limpeza** | (3) `removeStats(instanceId)` — novo método (`src/controllers/core/componentStatsController.js:19`, `:46`, `:55`); (4) remover componentes internos do host (`src/controllers/core/InternalComponentController.js:262`) + ressincronizar a cópia da entidade (padrão `src/controllers/core/stateEntityController.js:94`); (5) `removeEntityFromCache` + `reEvaluateEntityCapabilities` (`src/controllers/core/stateEntityController.js:101-103`, `:150-153`); (6) `releaseSelection` do componente (`src/controllers/actions/actionSelectController.js:330`) | (3') `_cleanupTracking` (`src/controllers/core/HoldingCostController.js:554-561`); (5') reavaliar capacidades (padrão `:362-363`); (6') liberar a selection do `eqId` |

**Por que esta ordem:**
- **(a) primeiro:** o conteúdo só é endereçável enquanto o host existe — os `hostComponentId` dos itens apontam para o id que está sendo destruído; remover o host antes (b) órfã os itens (deixariam de ser enumeráveis por `getContainerItems`).
- **(a½) em seguida (revisão 3):** o conteúdo do host já foi derramado (regra de (a)) e os dependentes ainda estão **totalmente vivos** (no array, com stats e conteúdo) quando cada um é forçado a quebrar — a própria cadeia (a)–(b)–(c) de cada dependente executa corretamente. A remoção do host (b) **não** é pré-condição da remoção dos dependentes: cada um é autocontido (a única escrita que a fase (b) de um dependente pode produzir — a restauração P7 do unequip — cai nos stats do **próprio** dependente, que morrem no (c) dele, não nos do host). Justificativa completa e ordem de visita: §3.6.4.
- **(b) em segundo:** a restauração do holding cost do unequip precisa da instância de stats do destino ainda viva (o host, no caso `component` — removida só em (c)); no caso `equipped-item`, o destino é o host (um componente sadio, possivelmente) — e é ali que mora o P7.
- **(c) por último:** a reavaliação de capacidades (o passo que decide o que client/IA enxergam) deve observar o estado **final** — componentes, stats, inventário e equipamentos já removidos; rodar antes deixaria capacidades stale.

#### 3.5.3 Atomicidade — mesma transação, um único batch de broadcasts (verificado no código)

O spill faz parte da **mesma** chamada `removeBrokenComponent(payload)` que a remoção (mesma transação, mesmo lote de escritas) — não há segundo turno:

1. **Helper puro:** o bloco extraído de `DropItemHandler` (`:96-119`) só escreve no mapa `droppedItems` via `setDroppedItems` (`src/controllers/WorldStateController.js:1667-1673` — operação pura, sem broadcast interno);
2. **Remoção sem auto-broadcast:** a drenagem usa `InventoryManager.removeItem` sobre a entidade ao vivo (a façade detém o `inventoryManager` em `src/controllers/WorldStateController.js:108`; `getEntity` devolve referência viva, `src/controllers/core/stateEntityController.js:171-173`) — e **não** `removeItemFromEntity` da façade, que terminaria em broadcast próprio (`:1367-1369`);
3. **Unequip sem broadcast:** `HoldingCostController.unequipItem` não broadcasta (verificado — zero chamadas de broadcast no controller);
4. **Única fonte de broadcast dentro da cascata** = o write de restauração do holding cost (P7) re-entrando no listener de mudança de stat da façade. O broadcast de fim do listener é **suprimido por um contador de reentrância** na façade: incrementado no início de `removeBrokenComponent`, decrementado no `finally`; os dois listeners (`src/controllers/WorldStateController.js:128`, `:151`) só disparam `broadcast()` quando o contador == 0. Resultado: **exatamente um** `world-state-update` por cadeia de quebras (o do listener mais externo, já com o estado final) — cobre P7 encadeado **e (revisão 3) a cascata de dependência inteira (§3.6.4): cada forçamento de dependente re-entra neste mesmo contador, então nenhum broadcast intermediário da cadeia de dependentes vaza**. O trigger **não** auto-broadcasteria no caminho normal; o broadcaster injetado via `setBroadcaster` permanece como fallback defensivo (ex. façade sem broadcaster em testes).

**Contexto do executor — drop por sistema (verificação do requisito 3):** o drop do spill **não precisa de socket nem de executor**. O parâmetro `context` de `handleDropItem` é JSDoc-only (nunca referenciado no corpo — verificado); o bloco extraído consome apenas a façade (`getItemRegistry` `:1307-1308`, `getDroppedItems` `:1635-1641`, `setDroppedItems`), a entidade (para `location` → `roomId`) e os dados do item. O trigger fornece `ownerId = payload.entityId` e `roomId = payload.roomId` direto do payload; o "executor" é o sistema do mundo (sem socket).

**Isolamento e idempotência:** (a)+(b) formam o caminho primário que deve sempre concluir; um item cuja gravação falha é logado e **pulado** (não aborta a quebra); os passos de (c) têm isolamento próprio com log — qualquer resíduo é consertado pela reavaliação de capacidades da próxima mudança de stat. A remoção é **idempotente**: uma segunda emissão para o mesmo componente/item é no-op com log de debug (necessário no caso do loop de P2 — §6).

**O que a remoção não faz:** a entidade **não é despawnada** quando perde o último componente (fora do escopo — a entidade fica inerte, estado que a IA de NPC já trata como sem ações utilizáveis, `src/controllers/ai/NpcAIController.js:319`); o conteúdo derramado **não** é destruído — fica jogável no chão (pickup). Efeitos colaterais positivos: fecha a lacuna de "componente fantasma" no caminho de quebra (a instância de stats deixa de existir no ato da quebra) e a IA de NPC fica mais robusta (o componente quebrado simplesmente deixa de existir, em vez de depender do filtro `durability < 1`).

**Visibilidade no client:** um único `world-state-update` (o batch de fim da cadeia, §3.5.3) já mostra o mundo sem o componente, com o conteúdo derramado e as facas no mapa — o client re-renderiza a partir do estado (ComponentViewer + `renderDroppedItemsOnSpatialMap`, `public/js/UIManager.js:224`), sem mudança de código client.

### 3.6 Cascata de quebra por dependência (revisão 3 — requisito novo)

**Requisito (usuário):** "Se um componente quebrado tem outros componentes **DEPENDENTES** dele, eles também devem quebrar" — **recursivamente**. Exemplo do usuário: se a **PERNA** de uma pessoa é arrancada, o **PÉ** e os **DEDOS** (que dependem da perna) também são arrancados.

#### 3.6.1 Investigação — o que existe hoje e o que falta

| Fonte | O que existe | O que falta |
|-------|-------------|-------------|
| [`data/blueprints.json`](data/blueprints.json) | O **único** lugar dos dados que codifica relações entre componentes: uma **árvore de composição** — chave = tipo do componente-pai, valor = lista de filhos (string ou `[tipo, identifier]`): `smallBallDroid → centralBall → { droidHead, droidArm×2 → droidHand×2 → humanoidDroidFinger×6, droidRollingBall×2 }`; idem `merchantDroid → merchantCore → …` | A direção é pai→filho (composição) e **em nível de tipo** — não é um campo de "dependência" e não diz qual *instância* depende de qual |
| [`data/components.json`](data/components.json) | Definições de tipo com apenas `traits` (ex.: `droidArm` dur. 50 → `droidHand` dur. 40 → `humanoidDroidFinger` dur. 30, `:15-34`) | Nenhum `dependsOn`, nenhum campo de pai, nenhuma relação entre tipos |
| [`data/npcs.json`](data/npcs.json) | 1 NPC: `smallBallDroid` ("Rogue Droid", `:2`) — e **nenhum** NPC com componentes humanos | **Não existe "pessoa" no data**: os componentes `perna`/`pé`/`dedos` do exemplo do usuário **não existem** — o análogo mais próximo presente é a cadeia `droidArm → droidHand → humanoidDroidFinger` (3 níveis, mesma forma estrutural de perna→pé→dedos) |
| [`src/utils/WorldGraphBuilder.js`](src/utils/WorldGraphBuilder.js:13) | Um grafo de **salas** (rooms + portas) para o world map — o nome sugere "grafo do mundo", mas `build()` (`:45`) só resolve conexões entre salas | Não é grafo de componentes: **não existe** aresta componente→componente em lugar nenhum do código |
| [`src/controllers/core/entityController.js`](src/controllers/core/entityController.js:29) | `expandBlueprint` expande a árvore recursivamente em lista **plana** `[tipo, identifier]` em **pré-ordem** (o pai é sempre pushado antes dos filhos, `:46` vs `:54/:71`; visited-set por ramo já impede recursão infinita, `:30`); `createEntityFromBlueprint` (`:83`) cria as instâncias `{ type, identifier, id }` (`:90-94`) | **O vínculo pai→filho é perdido no runtime**: a instância não carrega referência à instância-pai — o único vestígio é o sufixo string do `identifier` dos filhos em forma de array (`${child}_${parent}`, `:55`), frágil e não-semântico (e filhos em forma de string nem sufixo recebem — `:71`) |
| [`src/controllers/core/InternalComponentController.js`](src/controllers/core/InternalComponentController.js:192) | Eixo **separado** de "interno": instâncias **dentro** do componente-hospedeiro (`{ id, type, hostComponentId, hostComponentType, installedAt }`) **sem** stats por instância | Não é dependência: interno não quebra (sem stats) e não entra na árvore do blueprint — **fora de escopo confirmado pelo usuário (revisão 3, §10)** |

**Verificação exaustiva:** busca por `dependsOn`/`dependent` em `data/`, `src/` e `public/` não encontra nenhum campo de dependência entre componentes (as ocorrências do termo no repo são o inglês "independent" em comentários/docs). **Conclusão:** hoje a *única* fonte de relações entre componentes é a árvore de composição de [`data/blueprints.json`](data/blueprints.json), que é achatada no spawn **sem preservar o vínculo de instância**. Falta: (1) o vínculo de instância preservado na expansão, (2) a semântica de cascata que o consome (§3.6.3–3.6.4), (3) os dados do exemplo do usuário — perna/pé/dedos + pessoa (§3.6.2).

#### 3.6.2 Modelo de dados — `dependsOn` de instância, derivado da árvore existente

**Decisão (schema mínimo):** a instância de componente do runtime (`entity.components[]`) ganha o campo **`dependsOn: [parentInstanceId]`** — array de ids de **instância** (não de tipo) dos pais diretos; raiz da árvore = `[]`. **Sem novo arquivo de dados e sem novo campo em [`data/components.json`](data/components.json)** — o grafo é derivado da árvore que **já existe** em [`data/blueprints.json`](data/blueprints.json) no momento da expansão:

- **Por que não nível de tipo** (campo em `components.json` ou novo `dependencies.json`): um vínculo por tipo não distingue instâncias repetidas — a boneca tem **duas** pernas, e o pé esquerdo depende da perna esquerda, **não** da direita; `dependsOn` por tipo quebraria os **dois** pés quando qualquer perna partisse. E duplicar a árvore em um segundo arquivo criaria uma **segunda fonte de verdade** para o que `blueprints.json` já declara (viola a decisão 1 do §8 — single source of truth).
- **Onde é gravado:** [`src/controllers/core/entityController.js`](src/controllers/core/entityController.js) — a expansão já percorre a árvore em pré-ordem (pai antes dos filhos), então `expandBlueprint` propaga o **índice do pai** na lista plana e `createEntityFromBlueprint` o resolve em `dependsOn: [instanceId]` após gerar os ids (`generateCompId`, [`src/utils/idGenerator.js`](src/utils/idGenerator.js)). Vínculo por **índice** (não por tipo+identifier) é robusto a colisões de identifier entre ramos — caso real: filhos em forma de string **não** recebem sufixo (`expandBlueprint:71`, quirk existente), então as duas instâncias `humanFoot` da boneca teriam identifier `default` idêntico; o vínculo por índice não depende disso.
- **Grafo resultante:** por entidade, uma **floresta de árvores** (uma por entrada de nível superior do blueprint) — subcaso de DAG. Ciclos são estruturalmente impossíveis na fonte de dados atual (o visited-set por ramo de `expandBlueprint:30` já impede expansão infinita no spawn), mas a cascata em runtime é **defensiva** contra dados não-árvores futuros (§3.6.4, §6).
- **Exemplo — `smallBallDroid` depois da mudança** (ids de instância abreviados): `centralBall` = raiz (`dependsOn: []`); `droidHead → [centralBall]`; `droidArm(left) → [centralBall]`; `droidHand(left) → [droidArm(left)]`; `humanoidDroidFinger(left_left) → [droidHand(left)]`. O campo é **aditivo**: viaja no broadcast de world state já existente (`getAll()`, `src/controllers/WorldStateController.js:658`); o client ignora campos desconhecidos — **sem mudança de código client** (mantém a decisão 6 do §8).

**Seed do exemplo do usuário (perna → pé → dedos) — os componentes não existem; criação na fase de implementação:**

| JSON tocado na fase de implementação | Mudança |
|--------------------------------------|---------|
| [`data/components.json`](data/components.json) | 3 tipos novos, mesma forma dos existentes: `humanLeg` (`Physical.durability` 60, `volume` 10), `humanFoot` (dur. 40, `volume` 6), `humanToes` (dur. 20, `volume` 3) — durabilidade **decrescente** na cadeia, mesmo padrão `droidArm` 50 → `droidHand` 40 → `humanoidDroidFinger` 30; offsets `Spatial` no estilo dos droids existentes |
| [`data/blueprints.json`](data/blueprints.json) | `humanLeg: ["humanFoot"]`, `humanFoot: ["humanToes"]` (forma de string — análogo exato do existente `droidArm: ["droidHand"]`); `humanDoll: [["humanLeg","left"],["humanLeg","right"]]` (blueprint de entidade de nível superior — a boneca tem 2 pernas, provando o **isolamento de irmãos** do vínculo de instância) |
| [`data/npcs.json`](data/npcs.json) | NPC novo `humanDoll` (`displayName: "Human Doll"`, `room: "start_room"`, `personality`, `ai.behavior: "passive"`) — a pessoa existe no bootstrap do mundo (mesmo caminho de `smallBallDroid`, [`src/controllers/WorldStateController.js`](src/controllers/WorldStateController.js:273)) |
| [`src/controllers/ai/NpcAIController.js`](src/controllers/ai/NpcAIController.js:59) | Registrar o behavior `passive` (estratégia no-op `{ acted: false, skipped: 'PASSIVE' }`, ao lado do `chase_attack` pré-registrado em `:59`) — a boneca não deve agir; behavior não registrado gera warn a cada tick de planning (`:106-108`) |

Os valores de stats são ajustáveis na implementação; o teste exige apenas a cadeia de 3 níveis com `Physical.durability` **diferente** por nível (cruzamento observável por componente) — o teste parte a perna com delta que **só a perna** cruza, de modo que pé e dedos quebram **somente** pela cascata (com durabilidade > 0 no momento, §6).

#### 3.6.3 Semântica da cascata — mesmo evento, mesma cadeia; N quebras ⇒ N eventos ⇒ 3N facas

Quando o componente **X** quebra (cruzamento `>0 → ≤0`, §3.1), todos os componentes da **mesma entidade** cujo `dependsOn` contém X **transitivamente** (os **dependentes** — direto: `pé → perna`; transitivo: `dedos → pé → perna`) são **forçados a quebrar**:

- **Mecanismo do forçamento (sem novo fio):** a cascata escreve `durability = 0` de cada dependente pelo **mutator já existente** `ComponentController.updateComponentStat(id, 'Physical', 'durability', 0)` ([`src/controllers/core/componentController.js`](src/controllers/core/componentController.js:99)) — o **mesmo funil** do §2: notificação → façade → TriggerController → cruzamento (`old > 0 → 0`) → **emit do próprio `component:broke` do dependente, com o MESMO payload do §3.3** (seus próprios `prevValue`/`value`; `position`/`roomId` da entidade dona). É um **arranco**: não se aplica redução proporcional do stat — o dependente sai do mundo como está (seus demais stats são irrelevantes: a instância morre na fase (c)).
- **Cada dependente passa pela MESMA cascata de remoção**: seu próprio spill (a), sua própria cascata (a½, recursivamente), seu próprio (b)–(c) — porque ele é apenas outro evento `component:broke` no mesmo funil, atendido pelos mesmos handlers.
- **O gatilho de teste dispara por CADA evento** — a regra "N quebras → N eventos → 3N facas" (1ª linha do §6) aplica-se **recursivamente**: perna + pé + dedos = **3 quebras = 3 eventos = 9 facas**, todas em raio 5 da posição da entidade quebrou, na sala dela, todas dentro do **batch único** de fim da cadeia (§3.5.3).
- **O trigger permanece genérico:** `TriggerController` não sabe de dependências — ele reage a cada cruzamento que vê. O conhecimento do grafo vive **exclusivamente** no caminho de remoção (§3.6.4).

#### 3.6.4 Onde executa — dentro do caminho de remoção, fase (a½), pré-ordem com visited-set

**Decisão: dentro da cascata de remoção existente — concretamente, dentro do orquestrador da façade `removeBrokenComponent` (ao qual o `BrokenComponentRemovalHandler` já delega), como fase **(a½)** entre (a) e (b). Não é um novo handler.** Justificativa:

1. **É a única que conhece o grafo e o ciclo de vida:** o orquestrador já detém todos os sub-controllers da façade (entidade, stats, inventário, holding cost, internos, selection) **e** o contador de reentrância. Um novo handler precisaria de exatamente esse acesso, mais uma ordem de registro antes do handler de remoção, sem ganho — o handler de remoção permanece um **delegador fino** (SRP, espelhando os consequence handlers).
2. **Mantém o trigger genérico** (como acima): o gatilho de facas continua sendo um consumidor puro de "3 facas por evento", sem conhecer o grafo — o requisito da revisão é absorvido inteiramente pelo caminho de remoção.
3. **Posição (a½):** após (a) — o conteúdo do host já foi derramado enquanto ele ainda existia (regra de endereçabilidade, §3.5.2) — e antes de (b) — os dependentes estão **totalmente vivos** (no `components[]`, com stats e conteúdo) quando cada um é forçado, de modo que a própria cadeia (a)–(b)–(c) de cada um executa corretamente. (Detalhado no §3.5.2.)
4. **A reentrância já é coberta:** cada forçamento re-entra no listener da façade **dentro** do `try/finally` do orquestrador — o contador existente (§3.5.3) suprime todos os broadcasts intermediários da cadeia inteira → **um** `world-state-update` no fim, com o estado final. Nenhum mecanismo novo.

**Ordem de visita — pré-ordem (depth-first); dependentes diretos na ordem do array `components[]` (= a pré-ordem da expansão, i.e., a ordem declarada no blueprint):**

```
cascata(origin):
  visited = { origin }
  fila = [ origin ]
  while (cur = fila.shift()):
    for child of reverseIndex[cur] ou []:
      if visited.has(child): continue          // diamond: cada id entra na fila 1x por cascata
      visited.add(child)
      fila.push(child)
    if cur == origin: continue                 // origin já quebrou (evento que abriu a cascata)
    comp = entity.components.find(c => c.id == cur)
    if !comp: continue                         // liveness no pop: já removido nesta cadeia (diamond/P2)
    dur = stats[comp.id]?.Physical?.durability
    if dur == undefined: continue              // sem stat de durabilidade → não quebrável (log)
    if dur <= 0: remover direto (a)(b)(c) SEM evento e SEM facas (log warn)   // defensivo (§6)
    else: forçar — updateComponentStat(comp.id, 'Physical', 'durability', 0)
         // → evento do dependente → cadeia COMPLETA dele, aninhada e recursiva
```

- **Por que pré-ordem e não BFS por níveis:** a fase (a½) faz parte de *toda* cadeia de remoção, então partir um dependente de nível 1 **inevitavelmente** cascata os de nível 2 antes de terminar os demais do nível 1 — forçar "todo o nível 1 primeiro" exigiria um plano global pré-computado compartilhado entre as chamadas aninhadas (estado extra cruzando a fronteira do evento). A pré-ordem é o que a recursão natural do funil produz, é **determinística**, e coincide com a narrativa do exemplo do usuário: **perna → pé → dedos**, cada nível completando (spill → remover → limpar → 3 facas) antes de voltar ao ramo do pai. Em cadeia linear (o caso perna/pé/dedos e cada ramo do droid: arm→hand→finger), pré-ordem e BFS coincidem.
- **Consequências concretas (exemplo perna, boneca):** ordem dos **eventos**: perna, pé, dedos. Ordem dos **spills**: perna → pé → dedos (top-down; o conteúdo do pai é endereçável primeiro, regra de (a)). Ordem das **remoções**: dedos, pé, perna (mais profundo primeiro, por aninhamento). O ramo **direito** da boneca (perna/pé/dedos right) permanece intacto.
- **Ciclo A↔B (dados malformados) — sem loop infinito, por 3 defesas em camadas**, cada uma cobrindo o que a anterior não cobre: (1) **visited-set por cascata** — impede re-processar o mesmo id *dentro* da mesma cascata (a auto-dependência A→A morre aqui: a seed do visited é o próprio origin); (2) **liveness no pop** — impede re-processar id já removido por um ramo anterior (diamond C←A,B; remoção concorrente do loop P2); (3) **guard de cruzamento** (existente, §3.1) — última linha: uma segunda escrita num id com `old ≤ 0` ou sem stats **nunca** emite. Rastreando o ciclo: A quebra → cascata de A força B (evento B) → cascata de B encontra A (∉ visited de B, e A ainda está no array) → mas `durability(A) ≤ 0` → escrita 0 com `old ≤ 0` → **sem cruzamento → sem evento** → a cadeia termina. Cada componente é forçado no máximo 1× ⇒ O(nº de componentes da entidade).
- **Diamond (C depende de A e B; A e B dependem de X):** quebra X → eventos **X, A, C, B** (C quebra durante o ramo de A; a cascata de B encontra C já removido → liveness skip) — C processado **exatamente 1×**: 4 eventos, 12 facas, 1 broadcast. Determinístico: ordem dos dependentes = ordem do array `components[]`.
- **Profundidade ilimitada — decisão explícita, sem teto de profundidade:** perna→pé→dedos, a árvore completa do droid (centralBall→arm→hand→finger = 4 níveis) — tudo processado. A terminação é garantida **apenas** pelo visited-set + liveness + guard (O(N) por cascata, N = componentes da entidade — pequeno e finito, e já coberto pelo caso P2 multi-componente). Um **teto de profundidade seria rejeitado**: ele violaria silenciosamente o requisito "recursivamente" (o dedo, a nível 3, sobreviveria) para economizar um custo que já é O(N). Defesa extra upstream: o visited-set por ramo de `expandBlueprint:30` impede que uma *fonte de dados* com ciclo produza instâncias infinitas no spawn.
- **Índice reverso:** novo helper **puro** (stateless — padrão de [`wiki/subMDs/controllers/controller_patterns.md`](wiki/subMDs/controllers/controller_patterns.md)) em arquivo novo [`src/utils/ComponentDependents.js`](src/utils/ComponentDependents.js): entrada `components[]` (com `dependsOn`) → saída `Map<parentId, childId[]>` com a ordem do array preservada. Puro ⇒ unit-testável sem a façade; o orquestrador o chama a cada cascata (O(N), desprezível frente à remoção que dispara).

## 4. Gatilho de teste — 3 facas, raio 5, posições aleatórias

### 4.1 Item a usar

`knife` **já existe** em `data/inventoryItems.json:50` (volume 1, durability 30, sharpness 50) e já tem holding cost (`data/holdingCost.json:2`). **Não há necessidade de criar novo id de item.**

### 4.2 Posições aleatórias

Nenhum helper de "ponto aleatório em raio" existe: `shared/RangeResolver.js` resolve apenas expressões de range de ações (não é geometria), e `public/utils/geometry.js` é matemática client-side de bordas de salas. **Decisão:** novo utilitário puro (stateless, conforme §8 de `wiki/subMDs/controllers/controller_patterns.md`) com amostragem uniforme no disco (ângulo uniforme em 0..2π, raio por raiz quadrada do uniforme — evita viés para o centro, ao contrário de rejection sampling simples). Puro ⇒ testável com seed injetada. O mesmo utilitário serve ao **spill do §3.5.1** (raio 5, centro `payload.position` — cada item drenado sorteia sua própria posição): um sampler, dois consumidores, zero duplicação.

### 4.3 Centro e limites

- **Centro:** posição da entidade quebrou (`payload.position`). A entidade é o único âncora que sempre existe e que já vive no mesmo espaço dos dropped items (ambos os lados do pipeline os comparam diretamente) — **confirmado com o usuário (pergunta 1)**. A remoção do componente (§3.5) não move a entidade, então o centro permanece válido para o drop das facas (2º handler).
- **Sem clamp para a sala:** `DropItemHandler` já grava pontos sem clamp (o range da ação `dropItem` é 100, maior que qualquer sala — `src/controllers/consequences/DropItemHandler.js:107-108`); raio 5 é 20× menor, e `roomId` permanece o da entidade quebrou (mesma semântica de `src/controllers/consequences/DropItemHandler.js:109`). Não clamping evita acoplar o trigger à geometria das salas e ao espaço exato de `spatial` (documentação ambígua sobre room-relative em `src/controllers/core/stateEntityController.js:125`). O **spill** reusa exatamente este contrato: mesmo centro (`payload.position` = `entity.spatial`), mesmo raio 5, sem clamp, `roomId` da entidade (§3.5.1).

### 4.4 Quem executa o drop — reuso de `DropItemHandler`

`handleDropItem` exige que o item esteja no inventário da entidade que dropa — as facas do trigger (e os itens do spill) são **gravados**, não movidos. **Decisão:** extrair o bloco "gravar item no mapa de dropped items" (`src/controllers/consequences/DropItemHandler.js:96-119`) num helper exportado dentro de `DropItemHandler.js`, com parâmetro `nestedItems` (default `[]`), usado por três consumidores: `handleDropItem` (passa o resultado do próprio `_collectNestedItems` (`:82-87`) — comportamento inalterado), o gatilho de teste (default `[]` — facas não têm conteúdo) e o **spill** do §3.5.1 (passa o snapshot profundo de cada item drenado). Para cada uma das 3 facas: novo id de instância via `generateItemId()` (`src/utils/idGenerator.js`), `itemType: 'knife'`, `roomId` = sala da entidade quebrou, `ownerId` = entidade quebrou. O helper **não exige socket nem executor** (o parâmetro `context` de `handleDropItem` é JSDoc-only — nunca referenciado no corpo; detalhado em §3.5.3).

### 4.5 Log, broadcast e o que o client vê

- O core registra `component:broke` (warn); o handler registra o drop (action `dropItem`, level `info`) e usa o `Logger` central.
- No caminho normal, o gatilho **não auto-broadcasta**: a gravação das 3 facas (e do spill) entra no **batch único** do broadcast de fim do listener (§3.5.3) — `droppedItems` faz parte de `getAll()` (`src/controllers/WorldStateController.js:658`). O broadcaster injetado via `setBroadcaster` (padrão de `TurnSystemController`) permanece como **fallback defensivo** (ex. façade sem broadcaster em testes). O client recebe via `world-state-update` (`src/services/WorldStateBroadcastService.js:26`) e renderiza com `renderDroppedItemsOnSpatialMap` (`public/js/UIManager.js:224`). **Sem mudança de código no client** para o resultado visível.

### 4.6 Registro do gatilho de teste

Handler em módulo próprio `src/controllers/triggers/KnifeDropTriggerHandler.js` (SRP, como os consequence handlers), registrado contra `component:broke` **após** o handler built-in de remoção (§3.5) — a ordem de registro é a ordem de execução, e o drop não depende do componente já removido. **Ativação (decisão do usuário — pergunta 2): sempre ativo no mundo, registrado na composition root.**

## 5. Tabela de mudanças

| Arquivo | Mudança | Motivo |
|---------|---------|--------|
| `src/controllers/triggers/TriggerController.js` (novo) | Núcleo: registro on/off, os dois handlers que consomem as notificações existentes, check de cruzamento, emit com isolamento por handler, registro no event log | Consumidor único dos dois chokepoints já existentes → single source of truth sem tocar nenhum writer de dano/desgaste |
| `src/controllers/triggers/BrokenComponentRemovalHandler.js` (novo) | Handler built-in, registrado **1º** em `component:broke`: delega à façade o orquestrador `removeBrokenComponent(payload)` — cascata **(a) drenar/spill → (a½) cascata de dependência (§3.6) → (b) desequipar/remover → (c) limpeza** (§3.5). **Revisão 3: este arquivo não muda** — a fase (a½) vive no orquestrador da façade (§3.6.4) | Requisito do usuário (revisado): durabilidade zero ⇒ componente sai do mundo **e seu conteúdo é derramado no chão**; módulo próprio por SRP, espelhando os consequence handlers — a cascata de dependência não vira um handler novo (o trigger permanece genérico, §3.6.4) |
| `src/controllers/triggers/KnifeDropTriggerHandler.js` (novo) | Gatilho de teste: 3 facas, pontos aleatórios em raio 5 (mesmo sampler do spill, §4.2), via helper do DropItemHandler, log (broadcast = batch único da cascata, §3.5.3); registrado **2º** (após a remoção) | Requisito 2 do usuário; módulo próprio por SRP |
| `src/utils/` (novo, p.ex. `RandomPoint.js`) | Utilitário puro: ponto aleatório uniforme em disco de raio r — **compartilhado** pelo gatilho (3 pontos) e pelo spill (1 ponto por item drenado) | Não existe helper equivalente (RangeResolver é de expressões; geometry.js é client de bordas de sala) |
| `src/controllers/WorldStateController.js` | (1) delegar aos dois listeners já existentes (`:128`, `:151`) a chamada ao TriggerController, antes do broadcast; (2) pass-through fino `getEntities()` (hoje só existe `getEntity`, `:916`; `stateEntityController.getAll()` existe em `:198`); (3) novo orquestrador `removeBrokenComponent(payload)` — a cascata (a)→**(a½)**→(b)→(c) do §3.5/§3.6 sobre os sub-controllers que a façade já detém, com **contador de reentrância** (incrementa na entrada, decrementa no `finally`): os dois listeners só disparam o broadcast de fim quando o contador == 0 → **um único `world-state-update` por cadeia de quebras** (incl. P7 **e a cascata de dependência inteira** — revisão 3), sem broadcast de estado parcial. (Revisão 3) a fase (a½) = `reverseIndex` via helper puro + visited-set + pré-ordem + forçamento por `updateComponentStat(id,'Physical','durability',0)` no mutator existente (§3.6.4) | Sem fios novos — o trigger vê os mesmos sinais do capability controller; a façade continua sendo a única raiz do grafo e a única rota de escrita (regra §2), o que dá atomicidade à cascata multi-controlador e um batch único por cadeia — a cascata de dependência re-entra no MESMO contador, sem mecanismo novo |
| `src/controllers/core/componentStatsController.js` | Novo `removeStats(instanceId)` (hoje só `setStats`/`getStats`/`getAll` — `:19`, `:46`, `:55`) | A remoção do componente exige eliminar a instância de stats; sem este método a remoção deixaria entrada órfã no store (o "componente fantasma" continuaria existindo nos dados) |
| `src/controllers/core/stateEntityController.js` | Novo `removeComponent(entityId, componentId)` — **substitui** o array `components[]` via filter (nunca mutação in-place) | O loop de dano com alvo `entity` (P2) pode estar iterando o array no momento da remoção; a substituição torna a iteração concorrente segura (edge cases §6) |
| `src/composition/WorldComposition.js` | Construir o TriggerController, injetar façade + broadcaster pós-construção, registrar primeiro o handler de remoção e depois o gatilho de teste | A composition root é o único caminho suportado de construção (regras do projeto §2); a ordem de registro determina a ordem de execução |
| `src/controllers/consequences/DropItemHandler.js` | Extrair o bloco de gravação de dropped item em helper exportado **com parâmetro `nestedItems` (default `[]`)**, sem socket/executor; `handleDropItem` passa a usá-lo sem mudança de comportamento | O trigger **e o spill** reutilizam as mesmas semânticas de drop (formato de id, roomId, nested items) sem duplicar lógica |
| `test/` (novo, p.ex. `test/contract/triggerComponentBroke.contract.test.js`) | Casos da seção 7 — incluindo os de spill (testes 12–15) **e os de cascata de dependência (testes 16–21, revisão 3)**. **Test 16 reescrito** (pós-remoção humanDoll): usa árvore do `smallBallDroid` (centralBall → 14 nós → 14 eventos/42 facas). | Padrão vitest + `buildWorldState()` sem tick rodando, idêntico a `test/unit/NpcAIController.durabilityDesync.test.js` |
| `data/components.json` (removido — 3 entradas, decisão do usuário) | `humanLeg`, `humanFoot`, `humanToes` **removidos**. | Seed do exemplo do usuário removida por decisão do usuário ("esse npc nunca deveria existir"). Cascata validada pelo droid existente. |
| `data/blueprints.json` (removido — 3 entradas, decisão do usuário) | `humanLeg`, `humanFoot`, `humanDoll` **removidos**. | Mesma razão; árvore de dependência agora testada via `smallBallDroid`. |
| `data/npcs.json` (removido — 1 entrada, decisão do usuário) | `humanDoll` **removido**. | Mesma razão. |
| `src/controllers/ai/NpcAIController.js` (removido, decisão do usuário) | Behavior `passive` **removido**. | Nunca deveria ter existido; sem humanDoll, não há uso. |
| `src/controllers/core/entityController.js` (alterado, revisão 3) | `expandBlueprint`: propagar o **índice do pai** na lista plana (pré-ordem); `createEntityFromBlueprint`: instância `{ type, identifier, id, dependsOn: [parentInstanceId] }` (raiz = `[]`) | Grava o vínculo de instância que o achatamento de hoje **perde** (§3.6.1) — a única mudança de código que produz o grafo; sem novo arquivo de dados (§3.6.2) |
| `src/utils/ComponentDependents.js` (novo, revisão 3) | Helper puro/stateless: `components[]` (com `dependsOn`) → índice reverso `Map<parentId, childId[]>` (ordem do array preservada) | A cascata precisa da direção inversa (pai→filhos); puro ⇒ unit-testável sem a façade (padrão de `wiki/subMDs/controllers/controller_patterns.md`) |
| `wiki/map.md` + mapas de arquitetura em `wiki/subMDs/` | Adicionar o TriggerController, o handler de remoção **e a cascata de dependência** (§3.6) aos mapas; atualizar a seção de componentes/entidades com o campo `dependsOn` de instância | Regra do projeto §7: mapas devem ser mantidos atualizados |

## 6. Edge cases

| Caso | Comportamento decidido | Por quê |
|------|------------------------|---------|
| 3+ componentes quebram na mesma ação (P2, alvo `entity`) | Um `component:broke` **por componente**, com remoção de cada um; o gatilho de teste dropa 3 facas **por evento** → 3N facas no total | O requisito define o gatilho por quebra de componente; teto global por tick seria extensão opcional, fora do escopo |
| Dano repetido em componente já quebrado (old ≤ 0 → novo < 0) | Não re-dispara (o cruzamento exige old > 0) | Quebra é evento de fronteira, não de estado |
| Reparo cruzando 0 → positivo (repair sphere por tick, restauração no unequip) | Não dispara (apenas cruzamento para baixo) | Evita spam de eventos em ciclos de dano/reparo |
| Entidade já despawnada no momento da quebra (disconnect → `despawnEntity`, `src/controllers/core/stateEntityController.js:148`) | Trigger não encontra entidade dona → registra warn e **pula remoção, spill e drop** (sem âncora — §3.5.1 não tem onde derramar) | `despawnEntity` **não** limpa os stats dos componentes — componentes "fantasma" podem receber escritas de tick depois do despawn (lacuna conhecida, candidata a nota de bug); o guard mantém o trigger seguro |
| Item equipado quebra (P8) | Evento com `kind = 'equipped-item'`; o item é **desequipado e a instância removida** do inventário, e **o conteúdo do recipiente é derramado no chão (spill, §3.5.1)** — 1 nível, containers preservados em `nestedItems`, sem flatten | Decisão do usuário (pergunta 3, revisada): quebra ⇒ saída do mundo + **conteúdo jogável no chão**; o unequip restaura o holding cost no host (único delta negativo → P7) |
| Item equipado num host componente que quebra | Desequipado e removido na fase (b) da cascata do host (§3.5.2) — itens *armazenados* no host são derramados na fase (a); se o item quebrar depois no mesmo loop, a remoção é no-op com guard | Evita referência pendurada para um componente que deixou de existir |
| Loop de ação com alvo `entity` (P2) ainda iterando no momento da remoção | O array `components[]` é **substituído** (filter), nunca mutado in-place: o loop continua sobre a referência velha, as escritas chegam ao store por `componentId` e a quebra posterior de um componente já fora da lista é no-op sem exceção | Evita skip de componentes e mutação parcial durante iteração |
| Entidade cujo último componente quebra | A entidade **permanece** no mundo (sem despawn) com zero componentes; fica inerte — a IA de NPC já trata "sem componentes utilizáveis" como sem ações (`src/controllers/ai/NpcAIController.js:319`) | Despawnar não foi solicitado; o estado inerte é o comportamento natural do sistema de capacidades |
| Restauração do unequip de item quebrado quebra o host (P7 dentro da cascata) | Segundo `component:broke` do host na mesma cadeia: o host sofre a **mesma cascata completa** (spill + remoção) dentro da chamada em curso (idempotência + isolamento por handler); os broadcasts intermediários dos listeners são **suprimidos pelo contador de reentrância** (batch único no fim, §3.5.3) | A restauração no unequip é o único delta que pode ser negativo (`src/controllers/core/HoldingCostController.js:347`) |
| Espaço no chão / limite de itens | O mapa `droppedItems` não tem limite (comportamento existente de `dropItem`); o trigger **e o spill** não acrescentam limite e documentam o risco de acúmulo (cada quebra adiciona 3 facas + N itens derramados) | Adicionar limite mudaria comportamento existente — decisão separada |
| Reentrância (o drop quebrar outros componentes e re-disparar) | Estruturalmente impossível para o **spill**: gravar dropped item + remover do inventário plano não escreve nenhum stat, não executa ação e não chama mutator → não há notificação → não há re-dispatch | O drop só toca o mapa `droppedItems` (a reentrância *possível* é a restauração do holding cost na fase (b) — linha acima) |
| Ponto fora da sala da entidade quebrou | Permitido (sem clamp, §4.3); `roomId` continua sendo o da entidade | Consistente com `dropItem` (sem clamp, range 100 > tamanho da sala) |
| Persistência entre reinícios | As facas **e os itens derramados** persistem (`droppedItems` faz parte do snapshot — `test/contract/persistence.contract.test.js`); o componente removido **não** reaparece (a instância não existe mais) | Documentado; sem mudança |
| Componente interno quebra | Não quebra (sem stats por instância) — fora de escopo (pergunta 4) | Ver seção 2 |
| Spill de N itens com a entidade já despawnada (notificação de stat sem posição) | Spill **descartado** (log warn): sem âncora de posição (a notificação não carrega `spatial`) e `entity.items` já removido pelo `despawnEntity`; criar dropped items com `roomId`/`ownerId` fantasmas os tornaria injogáveis | Sem âncora não há onde derramar; perda documentada, consistente com a linha despawn acima |
| Recipiente com recipiente dentro (container no host destruído) | Drenagem de **1 nível**: cada item direto vira seu próprio dropped item; sub-containers viajam no `nestedItems` do pai (cópia profunda, `_collectNestedItems` — `src/utils/InventoryManager.js:492-511`) — **sem flatten** | Mesmas semânticas do drop manual; o pickup reconstrói a árvore (`src/controllers/consequences/PickUpItemHandler.js:136-158`) — hierarquia preservada e recuperável |
| Spill reentrando em quebras (o derramamento quebra algo) | Impossível: o spill só escreve no mapa `droppedItems` e remove do inventário plano — nenhuma escrita de stat → nenhuma notificação → nenhum novo `component:broke` | A única quebra reentrante possível é a restauração do holding cost na fase (b) (P7, linha acima) |
| Custo de broadcast do spill de N itens | A cascata inteira (spill de N + remoção + cadeia P7) produz **exatamente 1** `world-state-update` (contador de reentrância, §3.5.3) — nunca 1 broadcast por item | Sem tempestade de re-render no client e sem estado parcial vazando (`world-state-update` é estado completo) |
| **(revisão 3) Dependente já removido/despawnado no momento do pop** — removido por ramo anterior da mesma cascata, pelo loop P2 concorrente, ou entidade despawnada (linha existente acima) | **Skip seguro**: liveness no pop (id fora de `components[]` ou sem instância de stats) → log debug, a cascata continua com os demais; se a *entidade* despawnou, a cascata nem inicia (guard existente do trigger) | Visitado por cascata cobre o mesmo ramo; liveness cobre entre ramos; sem crash (teste 19) |
| **(revisão 3) Dependente com durabilidade > 0 no momento da cascata** | **Quebra forçada mesmo assim** — write 0 (arranco, §3.6.3): evento próprio + cadeia completa (spill/desequip/limpeza) + 3 facas; **não há redução proporcional do stat** — o dependente sai do mundo como está (demais stats irrelevantes: a instância morre no (c)) | Requisito do usuário: dependência = **arranco**, não desgaste adicional; o forçamento usa o mutator existente (mesmo funil, §3.6.3) |
| **(revisão 3) Dependente com durabilidade ≤ 0 no momento da cascata** (desync pré-existente documentado — durabilidade pode ficar negativamente profunda) | **Remoção direta via (a)(b)(c) SEM evento de cruzamento e SEM facas** — log warn; mantém o invariant "quebrado ⇒ fora do mundo" sem fabricar evento (o guard de §3.1 não dispara com `old ≤ 0`) | Caminho defensivo: com remoção inline, um componente ≤ 0 não deveria persistir; se existir (estado documentado do projeto pré-fix), é consertado na cascata, não re-eventado (teste 21a) |
| **(revisão 3) Auto-dependência** (`A.dependsOn` contém o id de A) | Ignorada: a seed do visited-set da cascata é o próprio origin → a auto-aresta nunca re-processa (subcaso do ciclo; morre na defesa 1) | Sem loop, sem evento extra (cobre o ciclo de comprimento 1) |
| **(revisão 3) Dependência de componente interno** (aresta `dependsOn` apontando para id de interno, ou id que não resolve em componente do mundo) | **Fora de escopo → ignorada, sem crash**: interno nunca quebra (sem stats por instância, §2) e não entra na árvore do blueprint; liveness no pop falha → skip + log info | Decisão do usuário confirmada na revisão 3 (§10): internos não participam da cascata |
| **(revisão 3) Entrelace profundo, profundidade ilimitada** (perna→pé→dedos; árvore completa do droid: centralBall→arm→hand→finger = 4 níveis) | Profundidade **sem teto** — terminação garantida **apenas** pelo visited-set + liveness + guard (O(N) por cascata, N = componentes da entidade); **teto de profundidade rejeitado** (violaria silenciosamente "recursivamente") | Justificativa completa em §3.6.4; teste 20 (árvore completa do droid, 14 eventos) |
| **(revisão 3) Ciclo A↔B** (grafo malformado) | Cada um quebra no máximo 1× — o 2º encontro morre nas 3 defesas em camadas (visited / liveness / guard de cruzamento, §3.6.4): **sem loop infinito**; 2 eventos, 6 facas, 1 broadcast | Teste 17 garante terminação com fixture de ciclo construído à mão |
| **(revisão 3) Diamond** (C depende de A e B; A e B dependem de X) | C quebrado **exatamente 1×** (na 1ª vez, durante o ramo de A); a 2ª aresta (via B) pulada por liveness; ordem determinística = ordem do array | Teste 18; sem re-spill nem re-drop de facas de C |
| **(revisão 3) Isolamento de irmãos** (boneca com 2 pernas) | Partir a perna **esquerda** cascata só pé+dedos do **ramo esquerdo**; o ramo direito intacto — o vínculo é de **instância** (`dependsOn: [id do pai]`), não de tipo | Propriedade que motiva a rejeição do modelo por tipo (§3.6.2); testado no 16 |
| **(revisão 3) Droids existentes: `centralBall` quebra** | Cascata na árvore existente → os 13 dependentes quebram (14 eventos, 42 facas, 1 broadcast) — **mudança de comportamento intencional** (regra geral derivada da árvore já declarada em `blueprints.json`) | Consequência documentada do modelo derivado — risco §9; teste 20 |
| **(revisão 3) Loop P2 (alvo `entity`) + cascata aninhada** | A cascata remove componentes do array via substituição por filter (linha P2 existente cobre iteração segura); escrita em id já removido retorna `false` (sem stats) → nenhum evento; liveness/visited garantem 1 processamento por id | Extensão da linha P2; nenhuma interação nova de crash |

## 7. Plano de testes (vitest, síncrono, sem tick rodando)

Seguir o padrão de `test/unit/NpcAIController.durabilityDesync.test.js`: `buildWorldState(tick)` com `UniversalTickSystem` **não iniciado**; dano aplicado com a chamada exata que o pipeline faz (`updateComponentStatDelta(compId, 'Physical', 'durability', delta)`).

1. **Cruzamento:** old=10, delta −15 → exatamente 1 evento `component:broke`; event log recebe entrada `warn` com tick carimbado.
2. **Dano repetido:** deltas adicionais com old ≤ 0 → zero eventos novos.
3. **Reparo:** 0 → +1 (delta positivo) → zero eventos.
4. **Gatilho de teste:** o cruzamento gera exatamente 3 facas novas no mapa, todas com distância ≤ 5 da posição da entidade, `roomId` = sala da entidade, ids válidos e únicos.
5. **Múltiplos componentes:** dano de alvo `entity` quebra 3 componentes → 3 eventos, 3 remoções, 9 facas; sem skip de componentes pelo loop concorrente.
6. **Despawn:** quebra após despawn da entidade → evento registrado; remoção, spill e drop de facas todos pulados (zero novas entradas em `droppedItems`), sem exceção.
7. **Remoção de componente:** após o cruzamento — componente fora do array `components[]` da entidade; instância de stats inexistente no store (`ComponentStatsController.getAll()`); componentes internos do host removidos; capacidades da entidade reavaliadas; seleção do componente liberada.
8. **Remoção de item equipado:** `updateStatDelta` em `eqId` cruzando → evento com `kind = 'equipped-item'`; holding cost restaurado no host; instância do item fora do inventário; **conteúdo do recipiente derramado no chão** (1 nível; sub-containers preservados em `nestedItems`, sem flatten).
9. **Entidade com único componente que quebra:** a entidade permanece no mundo (não despawnada) com zero componentes; pipeline de capacidades/IA sem crash.
10. **Idempotência:** segunda escrita cruzando no mesmo componente (loop de P2 sobre a referência velha) → sem exceção, sem remoção dupla, resto do pipeline intacto.
11. **Isolamento:** handler que lança erro não afeta a pipeline, a remoção nem os demais handlers.
12. **Spill de componente (N itens):** componente com N itens (incl. 1 container com 2 netos) quebra → exatamente N dropped items novos (cada um com posição própria em raio ≤ 5 de `payload.position`, `roomId`/`ownerId` do payload); o container vira dropped item com `nestedItems` completo (2 netos); os N itens (e netos) somem de `entity.items`.
13. **Spill de item equipado que é recipiente (P8):** conteúdo derramado (1 nível, `nestedItems` preservado) + holding cost restaurado no host + instância fora do inventário; **1 único** `world-state-update` na cadeia (spy do broadcaster).
14. **Spill após despawn:** quebra após `despawnEntity` → evento registrado; remoção, spill e drop de facas todos pulados; `droppedItems` sem nenhuma entrada nova; sem exceção (complemento do teste 6).
15. **Batch único com P7 encadeado (spy do broadcaster):** item quebra → unequip restaura e quebra o host → **exatamente 1** chamada de `broadcast()` para a cadeia toda; o estado desse broadcast já contém: ambos os componentes fora, spill dos dois conteúdos, 6 facas; nenhum broadcast com estado parcial.
16. **Cascata do exemplo do usuário (perna→pé→dedos, revisão 3):** spawnar `humanDoll`; delta que **só a perna esquerda** cruza → **3 eventos** `component:broke` na ordem perna→pé→dedos (cada um com o payload §3.3 próprio); os 3 fora de `components[]`, instâncias de stats ausentes, seleção liberada, internals do host limpos; o ramo **direito** (perna/pé/dedos) intacto — isolamento de irmãos do vínculo de instância; **9 facas** (3 por evento, ids únicos, distância ≤ 5 da posição da boneca, `roomId`/`ownerId` da boneca); **exatamente 1** `broadcast()` (spy) com as 9 facas + as 3 remoções no payload.
17. **Ciclo A↔B (fixture com `dependsOn` cíclico construído à mão, revisão 3):** quebrar A → **2 eventos** (A, B), ambos removidos, **sem loop infinito** (o teste termina em tempo finito), 6 facas, 1 broadcast; nenhum 3º evento (as 3 defesas em camadas, §3.6.4).
18. **Diamond (C←A, B; A, B←X, revisão 3):** quebrar X → 4 eventos na ordem **X, A, C, B**; C removido **1×**; 12 facas; 1 broadcast; nenhum re-spill de C.
19. **Dependente faltando/despawnado (revisão 3):** (a) dependente removido manualmente de `components[]` antes da quebra → nenhum evento para ele, sem crash, a cadeia do pai completa (liveness no pop); (b) entidade despawnada antes da quebra → a cascata nem inicia (complementa os testes 6/14).
20. **Profundidade ilimitada — árvore completa do droid (revisão 3):** quebrar `centralBall` do `smallBallDroid` → **14 eventos** (centralBall + 13 dependentes: head, 2 arms, 2 hands, 6 fingers, 2 balls), **42 facas**, 1 broadcast, ordem determinística (pré-ordem do array) — prova do **sem-teto** de profundidade.
21. **Estados defensivos do dependente (revisão 3):** (a) dependente com durabilidade ≤ 0 (desync pré-existente) → remoção direta sem evento e sem facas, log warn; (b) dependente sem stat `Physical.durability` → skip seguro, sem crash, log.

## 8. Decisões já tomadas (resumo)

1. **Single source of truth:** o evento nasce do consumo das notificações de stat já existentes (ComponentController + EquippedItemStatsController), delegadas pela façade ao novo TriggerController — sem emitir nos handlers de dano, sem novo fio, sem clamping do store.
2. **Semântica de fronteira:** dispara só no cruzamento `>0 → <=0` de `Physical.durability` (uma vez por quebra; reparo não re-dispara).
3. **Registro de handlers em código** (on/off por nome de evento), espelhando o dispatcher existente de consequências; a ordem de registro é a ordem de execução (remoção 1ª, gatilho de teste 2ª).
4. **Remoção com spill (decisão do usuário — pergunta 3, revisada):** a quebra remove permanentemente o componente — ou o item equipado — do mundo, via handler built-in orquestrado pela façade (`removeBrokenComponent`), na ordem **(a) drenar/spill do conteúdo → (b) desequipar/remover a instância → (c) limpar internos/stats/capacidades/selection**; a entidade não é despawnada; **o conteúdo do componente/recipiente destruído é derramado no chão (1 nível, hierarquia preservada em `nestedItems`) — não mais "perdido"**; o item equipado num host removido (mas armazenado em outro componente) é desequipado + removido na fase (b).
5. **Reuso total do pipeline de drop:** o mesmo helper extraído de `DropItemHandler` (com `nestedItems`) e o mesmo sampler de disco (raio 5, sem clamp) servem às 3 facas do gatilho **e** ao spill do conteúdo; o drop de sistema não exige socket/executor; uma cadeia de quebras produz **1 único** `world-state-update` (contador de reentrância na façade); gatilho sempre ativo, registrado na composition root (decisão do usuário — pergunta 2).
6. **Client sem alterações**: o resultado visível (componente removido do painel + facas no mapa) chega pelo broadcast de estado já existente.
7. **Modelo de dependência (revisão 3):** vínculo de **instância** `dependsOn: [parentInstanceId]` gravado na expansão do blueprint (`EntityController`) — derivado da árvore existente em `blueprints.json` (fonte de verdade única; **sem** novo arquivo de dados, **sem** campo de tipo em `components.json` — nível de tipo não distingue instâncias repetidas, ex.: duas pernas); a única data nova = a seed do exemplo do usuário (perna/pé/dedos + boneca + behavior `passive`).
8. **Cascata (revisão 3):** executa **dentro** do caminho de remoção — fase **(a½)** do orquestrador da façade `removeBrokenComponent` (entre (a) e (b)); **sem** novo handler (`BrokenComponentRemovalHandler` permanece delegador fino; o trigger permanece genérico e não conhece o grafo); cada dependente é forçado por **write 0 no mutator existente** → mesmo funil → seu próprio `component:broke` (payload idêntico) → sua própria cadeia completa + 3 facas; **N quebras ⇒ N eventos ⇒ 3N facas** (perna+pé+dedos = 9); ordem **pré-ordem (depth-first)** na ordem do array, com visited-set por cascata + liveness no pop + guard de cruzamento (3 defesas em camadas contra ciclo/diamond/auto-aresta); **sem teto de profundidade** (terminação = visited-set, O(N)); o contador de reentrância já existente cobre a cadeia toda → **1 broadcast**.

## 9. Riscos / observações

- **Componentes fantasma (despawn):** despawn não limpa stats de componentes (lacuna pré-existente). No caminho de quebra a lacuna passa a ser invisível (a instância de stats é eliminada no ato da quebra, §3.5); o caso de despawn *sem* quebra continua candidato a bug fix separado.
- **Acúmulo de dropped items:** sem teto, cada quebra acumula 3 facas **mais N itens derramados** (todos persistidos no snapshot). Aceitável para o gatilho de teste; monitorar.
- **Espaço de coordenadas de `spatial`:** a doc de `moveEntity` fala em "room-relative", mas todo o pipeline (movimento, range, pickup) trata `spatial` e `droppedItem.x/y` como um único espaço. O design depende dessa interpretação — consistente com o comportamento atual, mas a documentação deve ser corrigida junto com a implementação.
- **Cascata parcial da remoção:** cada passo secundário de `removeBrokenComponent` tem isolamento próprio; se um falhar, o caminho primário já concluiu e a reavaliação de capacidades da próxima mudança de stat conserta o resíduo. O **único** broadcast (fim da cadeia, §3.5.3) pode refletir esse resíduo por um ciclo, mas **nenhum broadcast intermediário de meio de cascata vaza** (suprimido pelo contador de reentrância). Todos os passos logam.
- **Quebra encadeada (P7 dentro da cascata):** o unequip de um item quebrado restaura o holding cost no host — a única restauração que pode ser negativa (`src/controllers/core/HoldingCostController.js:347`) — e pode quebrar o host na mesma cadeia. Tratada por idempotência + isolamento por handler + **supressão de broadcasts intermediários**: cada quebra da cadeia gera seu próprio evento, seu próprio spill e suas próprias 3 facas, tudo dentro do **mesmo batch** — o client vê 1 `world-state-update` com o estado final, e a reavaliação de capacidades da última quebra é a autoritativa.
- **Mudança de comportamento dos droids existentes (revisão 3):** a cascata derivada da árvore existente aplica-se **imediatamente a todos os spawns** — ex.: `centralBall` quebrada ⇒ o droid inteiro sai do mundo (14 eventos/42 facas em 1 tick) em vez de perder peças. É a consequência **intencional** da regra geral sobre o que `blueprints.json` já declara, mas é uma mudança de gameplay que o dono do mundo deve estar ciente (e o teste 20 a documenta como comportamento esperado, não bug).
- **`dependsOn` no wire (revisão 3):** o broadcast de world state passa a carregar o campo nas instâncias de componente (aditivo; o client ignora campos desconhecidos — sem mudança de código client, decisão 6). Expõe o vínculo interno no client: inofensivo (dado de display/depuração) e registrado apenas para awareness.
- **Custo do tick com cascata profunda (revisão 3):** o pior caso (árvore completa do droid) = 14 eventos + 42 gravações de facas + N spills num único listener, tudo dentro do batch único de broadcast — o custo do caso P2 multi-componente já existe; a cascata o generaliza. O índice reverso é O(N) por cascata — desprezível.

## 10. Perguntas de decisão para o usuário

**Resolvidas pelo usuário:**

1. ✅ **Centro do raio 5** — **decisão: posição da entidade quebrou** (`entity.spatial`).
2. ✅ **Ativação do gatilho de teste** — **decisão: sempre ativo no mundo**, registrado na composition root.
3. ✅ **"Quebrado" e usabilidade** — **decisão (requisito novo): remover o componente quando a durabilidade chegar a zero** — implementado como handler built-in de remoção com cascata atômica na façade (§3.5), registrado antes do gatilho de teste. O trigger não é "só informativo".

**Resolvidas na revisão 3 (confirmação do usuário):**

4. ✅ **Componentes internos** — **decisão: FORA de escopo (descartados)** — sem stats por instância (nunca quebram, §2) e **não participam da cascata de dependência**; qualquer aresta `dependsOn` que aponte para um interno é ignorada sem crash (§3.6.4, §6).
5. ✅ **Clamp para a sala** — **decisão: NENHUM** — nem no drop das facas do gatilho nem no spill (§3.5.1/§4.3), consistente com o `dropItem` (sem clamp, range 100 > qualquer sala).

**Pendências restantes: nenhuma** — as 5 perguntas estão resolvidas; a spec está **fechada para implementação** (tabela de mudanças §5, plano de testes §7).
