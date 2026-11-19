import { useSyncExternalStore } from "react";
import { store } from "@/engine";

export const useStore = () => useSyncExternalStore(store.subscribe, store.get);
