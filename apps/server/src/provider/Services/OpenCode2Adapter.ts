/**
 * OpenCode2Adapter — shape type for the OpenCode2 provider adapter.
 *
 * The driver model ({@link ../Drivers/OpenCode2Driver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module OpenCode2Adapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * OpenCode2AdapterShape — per-instance OpenCode2 adapter contract.
 */
export interface OpenCode2AdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
