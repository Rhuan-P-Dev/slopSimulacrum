/**
 * ComponentResolver — Resolves source/target components for actions.
 * Single Responsibility: Determine which component(s) participate in an action based on binding rules.
 *
 * Extracted from ActionController to adhere to the Single Responsibility Principle.
 *
 * @module ComponentResolver
 */

import Logger from '../../utils/Logger.js';
import { componentSatisfiesRequirements } from '../../utils/RequirementChecker.js';

class ComponentResolver {
    /**
     * @param {WorldStateController} worldStateController - The root state controller.
     */
    constructor(worldStateController) {
        this.worldStateController = worldStateController;
    }

    /**
     * Builds a component list from action parameters.
     * @param {Object} params - Action parameters.
     * @returns {{ componentList: Array|null, sourceComponentId: string|null }}
     */
    buildComponentList(params) {
        if (params?.componentIds && Array.isArray(params.componentIds) && params.componentIds.length > 0) {
            return {
                componentList: params.componentIds,
                sourceComponentId: params.componentIds[0]?.componentId
            };
        }

        if (params?.attackerComponentId || params?.targetComponentId) {
            const sourceComponentId = params.attackerComponentId || params.targetComponentId;
            return {
                componentList: [{ componentId: sourceComponentId, role: params.selectedBindingRole || 'source' }],
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
     * @param {Object} action - The action definition.
     * @param {string} entityId - The entity ID.
     * @param {Object} params - Action parameters.
     * @param {Object} [fallbackResult] - Pre-computed fallback from requirement check.
     * @returns {string|null} The resolved source component ID, or null.
     */
    resolveSourceComponent(action, entityId, params, fallbackResult = null) {
        const entity = this.worldStateController.getEntity(entityId);
        if (!entity) return null;

        const binding = action.componentBinding;

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
                const actionName = Object.keys(this._getActionRegistry() || {}).find(k => this._getActionRegistry()[k] === action) || 'unknown';
                return {
                    valid: false,
                    reason: `Selected component "${sourceComponent.identifier}" does not have the required traits for "${actionName}". ` +
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
     * @param {string} componentId - The component ID.
     * @returns {Object|null}
     */
    _findComponentById(entityId, componentId) {
        const entity = this.worldStateController.getEntity(entityId);
        if (!entity?.components) return null;
        return entity.components.find(c => c.id === componentId) || null;
    }

    /**
     * Gets the action registry (for resolving action names).
     * @private
     * @returns {Object|null}
     */
    _getActionRegistry() {
        return null;
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