import {createPrivateKey,webcrypto} from 'node:crypto';
import {BasicConstraintsExtension,SubjectAlternativeNameExtension,X509CertificateGenerator} from '@peculiar/x509';

/** Real signed pair and intermediate chain, generated only inside isolated tests. */
export async function certificateChain(domain='download.example.test') {
 const crypto=webcrypto as any,algorithm={name:'ECDSA',namedCurve:'P-256'},signingAlgorithm={name:'ECDSA',hash:'SHA-256'};
 const issuerKeys=await crypto.subtle.generateKey(algorithm,true,['sign','verify']),keys=await crypto.subtle.generateKey(algorithm,true,['sign','verify']);
 const dates={notBefore:new Date(Date.now()-60000),notAfter:new Date(Date.now()+86400000*3)};
 const issuer=await X509CertificateGenerator.createSelfSigned({name:'CN=Download QA CA',keys:issuerKeys,signingAlgorithm,...dates,extensions:[new BasicConstraintsExtension(true,1,true)]},crypto);
 const leaf=await X509CertificateGenerator.create({subject:'CN='+domain,issuer:issuer.subject,publicKey:keys.publicKey,signingKey:issuerKeys.privateKey,signingAlgorithm,...dates,extensions:[new SubjectAlternativeNameExtension([{type:'dns',value:domain}])]},crypto);
 const private_key_pem=createPrivateKey({key:Buffer.from(await crypto.subtle.exportKey('pkcs8',keys.privateKey)),format:'der',type:'pkcs8'}).export({format:'pem',type:'pkcs8'}).toString();
 return {certificate_pem:leaf.toString('pem')+'\n'+issuer.toString('pem')+'\n',private_key_pem};
}
