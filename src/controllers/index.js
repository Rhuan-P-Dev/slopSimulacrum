/**
 * Controllers Barrel Export
 *
 * Provides a single entry point for importing all controllers from the controllers directory.
 * Follows the controller_patterns.md architecture: WorldStateController is the root injector.
 *
 * @module controllers
 * @example
 * ```javascript
 * import { WorldStateController } from '@controllers';
 * // or
 * import { WorldStateController, ActionController } from '@controllers';
 * ```
 */

// Root injector — must be imported first
import WorldStateController from './WorldStateController.js';

// Core state management
import RoomsController from './core/RoomsController.js';
import stateEntityController from './core/stateEntityController.js';
import EntityController from './core/entityController.js';
import ComponentController from './core/componentController.js';
import ComponentStatsController from './core/componentStatsController.js';

// Traits subsystem
import TraitsController from './traits/TraitsController.js';

// Action system
import ActionController from './actions/actionController.js';
import ActionSelectController from './actions/actionSelectController.js';
import ComponentResolver from './actions/ComponentResolver.js';
import RequirementResolver from './actions/RequirementResolver.js';
import RangeValidator from './actions/RangeValidator.js';

// Capability system
import ComponentCapabilityController from './capabilities/componentCapabilityController.js';

// Synergy system
import SynergyController from './synergy/synergyController.js';
import SynergyConfigManager from './synergy/SynergyConfigManager.js';
import SynergyComponentGatherer from './synergy/SynergyComponentGatherer.js';
import SynergyCalculator from './synergy/SynergyCalculator.js';
import SynergyCacheManager from './synergy/SynergyCacheManager.js';

// Consequence system
import ConsequenceHandlers from './consequences/consequenceHandlers.js';
import ConsequenceDispatcher from './consequences/ConsequenceDispatcher.js';
import StatConsequenceHandler from './consequences/StatConsequenceHandler.js';

// Networking
import LLMController from './networking/LLMController.js';
import SocketLifecycleController from './networking/SocketLifecycleController.js';

export {
    // Root injector
    WorldStateController,

    // Core
    RoomsController,
    stateEntityController,
    EntityController,
    ComponentController,
    ComponentStatsController,

    // Traits
    TraitsController,

    // Actions
    ActionController,
    ActionSelectController,
    ComponentResolver,
    RequirementResolver,
    RangeValidator,

    // Capabilities
    ComponentCapabilityController,

    // Synergy
    SynergyController,
    SynergyConfigManager,
    SynergyComponentGatherer,
    SynergyCalculator,
    SynergyCacheManager,

    // Consequences
    ConsequenceHandlers,
    ConsequenceDispatcher,
    StatConsequenceHandler,

    // Networking
    LLMController,
    SocketLifecycleController,
};