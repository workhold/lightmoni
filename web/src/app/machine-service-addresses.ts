export type AddressChoice={mode:'auto'|'manual';address:string;effective:string;effective_addresses:string[];source:'interface'|'manual'|'unavailable';needs_confirmation:boolean};
export type ServiceAddressCandidate={address:string;scope:'private'|'public';source:'interface'|'ssh_target'|'platform_source';interface?:string;observed_at:string;requires_confirmation:boolean};
export type MachineServiceAddressSettings={revision:number;target_generation:number;private:AddressChoice;public:AddressChoice;candidates:ServiceAddressCandidate[];updated_by:string;updated_at:string};
