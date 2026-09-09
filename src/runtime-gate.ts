let maintenanceReason: string | null = null;
let activePublications = 0;
let activeRuntimeActivities = 0;

export function maintenanceState(): { active: boolean; reason: string | null; activePublications: number; activeRuntimeActivities: number } {
  return { active: maintenanceReason !== null, reason: maintenanceReason, activePublications, activeRuntimeActivities };
}

export function beginMaintenance(reason: string): () => void {
  if (maintenanceReason) throw new Error(`Система уже находится в maintenance: ${maintenanceReason}`);
  if (activePublications > 0) throw new Error(`Нельзя начать ${reason}: сейчас выполняется публикация (${activePublications})`);
  if (activeRuntimeActivities > 0) throw new Error(`Нельзя начать ${reason}: ещё выполняются API-операции (${activeRuntimeActivities})`);
  maintenanceReason = reason;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (maintenanceReason === reason) maintenanceReason = null;
  };
}

export function beginPublicationActivity(): () => void {
  if (maintenanceReason) throw new Error(`Публикация временно заблокирована: ${maintenanceReason}`);
  activePublications += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activePublications = Math.max(0, activePublications - 1);
  };
}

export function beginRuntimeActivity(): () => void {
  if (maintenanceReason) throw new Error(`API временно заблокирован: ${maintenanceReason}`);
  activeRuntimeActivities += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeRuntimeActivities = Math.max(0, activeRuntimeActivities - 1);
  };
}

export function assertMutationAllowed(): void {
  if (maintenanceReason) throw new Error(`Изменения временно заблокированы: ${maintenanceReason}`);
}
