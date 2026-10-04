// Public entry: everything a host needs to embed the bridge.
export {
  createBridgeServer,
  resolveVariant,
  findElectronBinary,
  resolveElectronBinary,
  defaultElectronCandidates,
  defaultStateDir,
  findManagedCertificate,
  VARIANT_IDS
} from "./server.js";
