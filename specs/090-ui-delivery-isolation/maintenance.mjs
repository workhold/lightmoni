// Exact maintenance asset for the approved zz-bj-1 Registry deployment.
(async()=>{
 const fs=await import('node:fs'),{createHash}=await import('node:crypto'),{spawnSync}=await import('node:child_process');
 const requireTrue=(ok,code)=>{if(!ok)throw Error(code)};
 const digest=value=>createHash('sha256').update(value).digest('hex');
 requireTrue(process.platform==='linux'&&process.getuid()===0,'root_linux_required');
 const address=spawnSync('/usr/sbin/ip',['-o','-4','addr','show','dev','eth0'],{encoding:'utf8'});
 requireTrue(address.status===0&&address.stdout.split(/\s+/).includes('172.21.0.16/20'),'host_address_mismatch');
 const path='/usr/local/sbin/lightmoni-registry-firewall',before=fs.lstatSync(path);
 requireTrue(before.isFile()&&!before.isSymbolicLink()&&before.uid===0&&!(before.mode&0o022),'unsafe_firewall_file');
 const current=fs.readFileSync(path),oldSHA="39f66f19cfac5124c4169be18e8b78ffac3b9ff4c65501cec71e90e3fbc1b18b",newScript="#!/bin/sh\n# managed-by-lightmoni: abc-demo-registry-network-v2\nset -eu\nPATH=/usr/sbin:/usr/bin:/sbin:/bin\nexport PATH\niptables=/usr/sbin/iptables\nchain=LMREGISTRY_20000\n/usr/sbin/ip -o -4 addr show dev eth0 | /usr/bin/awk '{print $4}' | /usr/bin/grep -Fxq '172.21.0.16/20'\nif ! \"$iptables\" --wait 5 -S DOCKER-USER >/dev/null 2>&1; then\n  \"$iptables\" --wait 5 -N DOCKER-USER\nfi\nif ! \"$iptables\" --wait 5 -S \"$chain\" >/dev/null 2>&1; then\n  \"$iptables\" --wait 5 -N \"$chain\"\nfi\nif ! \"$iptables\" --wait 5 -C \"$chain\" -s 172.21.0.0/20 -j RETURN >/dev/null 2>&1; then\n  \"$iptables\" --wait 5 -I \"$chain\" 1 -s 172.21.0.0/20 -j RETURN\nfi\nif ! \"$iptables\" --wait 5 -C \"$chain\" -j DROP >/dev/null 2>&1; then\n  \"$iptables\" --wait 5 -A \"$chain\" -j DROP\nfi\nfor port in 20000 20001 20002; do\n  if ! \"$iptables\" --wait 5 -C DOCKER-USER -p tcp -m conntrack --ctdir ORIGINAL --ctorigdst 172.21.0.16 --ctorigdstport \"$port\" -m comment --comment lightmoni-registry-private -j \"$chain\" >/dev/null 2>&1; then\n    \"$iptables\" --wait 5 -I DOCKER-USER 1 -p tcp -m conntrack --ctdir ORIGINAL --ctorigdst 172.21.0.16 --ctorigdstport \"$port\" -m comment --comment lightmoni-registry-private -j \"$chain\"\n  fi\ndone\n",newSHA="1b4f4272e0dc81dcf7332efcd19c6bc4af4aefe388790fd7c2d9f4611c0a8095";
 requireTrue([oldSHA,newSHA].includes(digest(current)),'firewall_changed_since_review');
 if(digest(current)!==newSHA){
  const directory='/var/lib/lightmoni-registry-network';
  if(!fs.existsSync(directory))fs.mkdirSync(directory,{mode:0o700});
  const stat=fs.lstatSync(directory);requireTrue(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===0&&!(stat.mode&0o077),'unsafe_backup_directory');
  const backup=directory+'/firewall-'+oldSHA+'.sh';
  if(!fs.existsSync(backup)){const fd=fs.openSync(backup,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,current);fs.fsyncSync(fd);}finally{fs.closeSync(fd)}}
  const temporary=path+'.tmp-'+process.pid,fd=fs.openSync(temporary,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o700);
  try{fs.writeFileSync(fd,newScript);fs.fsyncSync(fd);}finally{fs.closeSync(fd)}
  requireTrue(digest(fs.readFileSync(path))===oldSHA,'firewall_changed_before_replace');fs.renameSync(temporary,path);
  const parent=fs.openSync('/usr/local/sbin',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(parent)}finally{fs.closeSync(parent)}
 }
 requireTrue(spawnSync(path,[],{stdio:'ignore'}).status===0,'firewall_apply_failed');
 for(const port of [20000,20001,20002]){
  const check=spawnSync('/usr/sbin/iptables',['--wait','5','-C','DOCKER-USER','-p','tcp','-m','conntrack','--ctdir','ORIGINAL','--ctorigdst','172.21.0.16','--ctorigdstport',String(port),'-m','comment','--comment','lightmoni-registry-private','-j','LMREGISTRY_20000'],{stdio:'ignore'});
  requireTrue(check.status===0,'firewall_rule_missing');
 }
 console.log(JSON.stringify({registry_private_ports:[20000,20001,20002],script_sha256:newSHA,applied:true}));
})().catch(error=>{console.error(error.message);process.exitCode=1});
