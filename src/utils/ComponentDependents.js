/**
 * ComponentDependents — puro, stateless (§3.6.4).
 * 
 * Constrói o índice reverso: parentId → childIds[] a partir de
 * `dependsOn` das instâncias de componente (entity.components[]).
 * 
 * Entrada: components[] com campo `dependsOn: [parentInstanceId, ...]`
 * Saída: Map<parentId, childId[]> na ordem do array preservada.
 * 
 * Seguro para arestas órfãs (parentId que não resolve em nenhum component)
 * e para auto-dependência (A.dependsOn contém A.id): o visited-set da
 * cascata impede loop (§3.6.4).
 * 
 * @module ComponentDependents
 */

/**
 * Constrói o índice reverso de dependências.
 * @param {Array<{id: string, dependsOn: string[]}>} components - Instâncias de componente com dependsOn.
 * @returns {Map<string, string[]>} parentId → childIds[].
 */
function buildReverseIndex(components) {
    if (!Array.isArray(components)) return new Map();
    const reverseIndex = new Map();

    // Inicializa todos como vazios (garante que todos apareçam no mapa)
    for (const comp of components) {
        if (!reverseIndex.has(comp.id)) {
            reverseIndex.set(comp.id, []);
        }
    }

    // Para cada componente, para cada pai, adiciona este filho à lista do pai
    for (const comp of components) {
        if (Array.isArray(comp.dependsOn)) {
            for (const parentId of comp.dependsOn) {
                if (!reverseIndex.has(parentId)) {
                    reverseIndex.set(parentId, []);
                }
                reverseIndex.get(parentId).push(comp.id);
            }
        }
    }

    return reverseIndex;
}

export { buildReverseIndex };
