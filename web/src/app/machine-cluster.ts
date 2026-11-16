export type MachineCluster = {cluster_id?:string;cluster_name?:string};

export const machineClusterMatches = (machine: MachineCluster, selected: string): boolean =>
  !selected || (selected === 'unassigned' ? !machine.cluster_id : machine.cluster_id === selected);

export const machineClusterOptions = (machines: MachineCluster[]) => {
  const clusters = new Map<string,string>();
  for (const machine of machines) if (machine.cluster_id) clusters.set(machine.cluster_id, machine.cluster_name || machine.cluster_id);
  return [
    {value:'unassigned',label:'未分配集群'},
    ...[...clusters].sort((left,right)=>left[1].localeCompare(right[1])).map(([value,label])=>({value,label})),
  ];
};
