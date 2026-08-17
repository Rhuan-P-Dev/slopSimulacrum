/**
 * ComponentResolver — Resolves source/target components for actions.
 * Single Responsibility: Determine which component(s) participate in an action based on binding rules.
 *
 * Extracted from ActionController to adhere to the Single Responsibility Principle.
 *
 * Uses typed IDs: component IDs are prefixed with `comp-` for unambiguous identification.
 *
 * @module ComponentResolver
 */

import Logger from '../../utils/Logger.js';
import { componentSatisfiesRequirements } from '../../utils/RequirementChecker.js';
import IdResolver from '../../utils/IdResolver.js';

class ComponentResolver {
    /**
     * FASE 5: the facade is no longer passed at construction; it is injected via
     * setWorldStateController() (called by ActionController.setWorldStateController()).
     */
    constructor() {
        /** @type {WorldStateController|null} Injected post-construction. */
        this.worldStateController = null;
    }

    /**
     * Injects the world state facade (WorldStateController) after it is fully built.
     * @param {WorldStateController} worldStateController - The fully-built facade.
     */
    setWorldStateController(worldStateController) {
        this.worldStateController = worldStateController;
    }

    /**
     * Builds a component list from action parameters.
     * Validates that all componentIds are typed component IDs (comp-${uuid}) or equipped item IDs (eq-${uuid}).
     * @param {Object} params - Action parameters.
     * @returns {{ componentList: Array|null, sourceComponentId: string|null }}
     */
    buildComponentList(params) {
        if (params?.componentIds && Array.isArray(params.componentIds) && params.componentIds.length > 0) {
            // Validate that all componentIds are typed component IDs or equipped item IDs
            const validComponentIds = [];
            const invalidIds = [];

            for (const comp of params.componentIds) {
                const compId = typeof comp === 'object' ? comp?.componentId : comp;

                if (!compId || typeof compId !== 'string') {
                    invalidIds.push(compId);
                    continue;
                }

                // Accept typed component IDs (comp-...), equipped item IDs (eq-...), and legacy raw UUIDs
                if (IdResolver.isCompId(compId) || IdResolver.isEquippedId(compId) || IdResolver.isLegacyCompId(compId)) {
                    const entry = typeof comp === 'object' ? comp : { componentId: compId, role: 'source' };
                    validComponentIds.push(entry);
                } else {
                    invalidIds.push(compId);
                }
            }

            if (invalidIds.length > 0 && validComponentIds.length === 0) {
                Logger.warn(`[ComponentResolver] All provided component IDs are malformed for action. Invalid: ${invalidIds.join(', ')}`);
                return { componentList: null, sourceComponentId: null };
            }

            const sourceComponentId = validComponentIds.length > 0 ? validComponentIds[0]?.componentId : null;
            return {
                componentList: validComponentIds.length > 0 ? validComponentIds : null,
                sourceComponentId
            };
        }

        if (params?.attackerComponentId || params?.targetComponentId) {
            const sourceComponentId = params.attackerComponentId || params.targetComponentId;
            const entry = { componentId: sourceComponentId, role: params.selectedBindingRole || 'source' };
            return {
                componentList: [entry],
                sourceComponentId
            };
        }

        return { componentList: null, sourceComponentId: null };
    }

    /**
     * Resolves the source component ID based on action binding configuration.
     * Resolution priority:
     * 1. attackerComponentId (punch actions)
     * 2. componentIds[0] (multi-component attacks)
     * 3. targetComponentId (spatial/self_target with explicit selection)
     * 4. Auto-find by role (spatial → Movement, self_target → Physical)
     * 5. Fallback → entity-wide best component
     *
     * Accepts both component IDs (comp-*) and equipped item IDs (eq-*).
     *
     * @param {Object} action - The action definition.
     * @param {string} entityId - The entity ID.
     * @param {Object} params - Action parameters.
     * @param {Object} [fallbackResult] - Pre-computed fallback of requirement check.
     * @returns {string|null} The resolved source component ID, or null.
     */
    resolveSourceComponent(action, entityId, params, fallbackResult = null) {
        const entity = this.worldStateController.getEntity(entityId);
        if (!entity) return null;

        const binding = action.componentBinding;

        // Validate and resolve component IDs from params
        const resolvedSourceComponentId = params?.attackerComponentId || params?.targetComponentId || params?.componentIds?.[0]?.componentId;

        // Validate that resolved ID is a typed component ID, equipped item ID, or legacy UUID
        if (resolvedSourceComponentId && typeof resolvedSourceComponentId === 'string' &&
            !IdResolver.isCompId(resolvedSourceComponentId) &&
            !IdResolver.isEquippedId(resolvedSourceComponentId) &&
            !IdResolver.isLegacyCompId(resolvedSourceComponentId)) {
            Logger.warn(`[ComponentResolver] Invalid component ID format: "${resolvedSourceComponentId}". Must be a typed comp-..., eq-..., or raw UUID.`);
            return null;
        }

        // Priority 1: Punch actions with explicit attackerComponentId
        if (params?.attackerComponentId) {
            return params.attackerComponentId;
        }

        // Priority 1.5: Multi-component attack actions
        if (params?.componentIds && Array.isArray(params.componentIds) && params.componentIds.length > 0 && params?.targetComponentId) {
            return params.componentIds[0].componentId;
        }

        // Priority 2: Explicit targetComponentId from client
        if (params?.targetComponentId) {
            return params.targetComponentId;
        }

        // Priority 3: Spatial actions — auto-find component matching spatialRole
        if (action.targetingType === 'spatial' && binding?.spatialRole) {
            const spatialComponent = this._findComponentByRole(entity, binding, 'spatial');
            if (spatialComponent) return spatialComponent.id;
        }

        // Priority 4: Self-targeting actions — find component matching selfTargetRole
        if ((action.targetingType === 'none' || action.targetingType === 'self_target') && binding?.selfTargetRole) {
            const selfComponent = this._findComponentByRole(entity, binding, 'self_target', action);
            if (selfComponent) return selfComponent.id;
        }

        // Priority 5: Fallback — entity-wide check
        if (fallbackResult?.passed) {
            return fallbackResult.componentId;
        }

        return null;
    }

    /**
     * Finds a component on an entity that matches a specific binding role.
     * @private
     * @param {Object} entity - The entity object.
     * @param {Object} binding - The action's componentBinding definition.
     * @param {string} role - The role to match ('spatial', 'self_target').
     * @param {Object} [action] - Optional action definition for self_target matching.
     * @returns {Object|null} The matching component, or null.
     */
    _findComponentByRole(entity, binding, role, action = null) {
        if (!entity?.components) return null;

        for (const component of entity.components) {
            const componentStats = this.worldStateController.componentController.getComponentStats(component.id);
            if (!componentStats) continue;

            if (role === 'spatial' && binding?.spatialRole) {
                if (componentStats.Movement && Object.keys(componentStats.Movement).length > 0) {
                    return component;
                }
            }

            if (role === 'self_target' && binding?.selfTargetRole) {
                if (action && this._componentSatisfiesActionRequirements(componentStats, action)) {
                    return component;
                }
                if (!action && componentStats.Physical && Object.keys(componentStats.Physical).length > 0) {
                    return component;
                }
            }
        }

        return null;
    }

    /**
     * Checks if a component satisfies ALL of an action's requirements.
     * @private
     * @param {Object} componentStats - The component's stats.
     * @param {Object} action - The action definition.
     * @returns {boolean}
     */
    _componentSatisfiesActionRequirements(componentStats, action) {
        if (!componentStats || !action?.requirements) return false;
        return componentSatisfiesRequirements(componentStats, action.requirements);
    }

    /**
     * Validates that the resolved component matches the expected binding role.
     * @param {Object} action - The action definition.
     * @param {string} entityId - The entity ID.
     * @param {string} sourceComponentId - The resolved source component ID.
     * @param {Object} params - Action parameters.
     * @returns {{ valid: boolean, reason: string }}
     */
    validateComponentBinding(action, entityId, sourceComponentId, params) {
        const binding = action.componentBinding;

        if (!binding) {
            return { valid: true, reason: '' };
        }

        const sourceComponent = this._findComponentById(entityId, sourceComponentId);
        if (!sourceComponent) {
            return { valid: false, reason: `Source component "${sourceComponentId}" not found on entity "${entityId}".` };
        }

        const sourceComponentStats = this.worldStateController.componentController.getComponentStats(sourceComponentId);

        // Validate source role: the component must have the traits required by the action
        if (binding.roles?.includes('source') || binding.spatialRole || binding.sourceRole) {
            if (!this._componentSatisfiesActionRequirements(sourceComponentStats, action)) {
                return {
                    valid: false,
                    reason: `Selected component "${sourceComponent.identifier}" does not have the required traits for this action. ` +
                            `Expected: ${action?.requirements?.map(r => `${r.trait}.${r.stat} >= ${r.minValue}`).join(', ')}.`
                };
            }
        }

        // Skip role validation for spatial and 'none' targetingType (client/server resolution differs)
        if (params?.selectedBindingRole && action.targetingType !== 'spatial' && action.targetingType !== 'none') {
            const resolvedRole = this._resolveComponentRole(action, sourceComponent);
            if (resolvedRole && params.selectedBindingRole !== resolvedRole) {
                return {
                    valid: false,
                    reason: `Component role mismatch: client selected role "${params.selectedBindingRole}" but component resolves to "${resolvedRole}".`
                };
            }
        }

        return { valid: true, reason: '' };
    }

    /**
     * Finds a component by ID within an entity.
     * @private
     * @param {string} entityId - The entity ID.
     * @param {string} componentId - The component ID (typed or legacy).
     * @returns {Object|null}
     */
    _findComponentById(entityId, componentId) {
        const entity = this.worldStateController.getEntity(entityId);
        if (!entity?.components) return null;
        return entity.components.find(c => c.id === componentId) || null;
    }

    /**
     * Resolves the role for a component within an action's binding context.
     * @private
     * @param {Object} action - The action definition.
     * @param {Object} component - The component object.
     * @returns {string|null}
     */
    _resolveComponentRole(action, component) {
        // This is handled by ComponentCapabilityController
        return null;
    }
}

export default ComponentResolver;