#!/usr/bin/env python3
"""Run bounded, uncached lighting and resume tests against the actual forest."""
from __future__ import annotations
import json,subprocess,sys,hashlib
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'))
from finish import read_pfm

def command(out,more):
    out.mkdir(parents=True,exist_ok=True)
    args=[str(ROOT/'build/cybr-film'),'--assets',str(ROOT/'assets'),'--out',str(out),'--mode','reference','--width','320','--height','180','--samples','64','--first','0','--last','0','--threads','4','--fog','0',*more]
    result=subprocess.run(args,capture_output=True,text=True)
    (out/'invocation.log').write_text(result.stdout+result.stderr)
    if result.returncode:raise RuntimeError(result.stderr[-2000:])

def main():
    out=ROOT/'renders/lighting-validation';out.mkdir(parents=True,exist_ok=True)
    for name,more in [('combined',[]),('sun',['--sky-scale','0']),('sky',['--sun-scale','0'])]:command(out/name,more)
    images=[read_pfm(out/name/'01_Threshold.pfm') for name in ('combined','sun','sky')]
    residual=np.abs(images[0]-images[1]-images[2]);scale=np.maximum(.03,np.abs(images[0]))
    result={'scene':'actual upgraded forest, not a synthetic fixture','dimensions':[320,180],'spp':64,'uncached':True,'atmosphere_disabled_for_linear_surface_pass_test':True,'maximum_absolute_linear_channel_residual':float(residual.max()),'p99_normalized_residual':float(np.quantile(residual/scale,.99)), 'full_convergence_certified':False}
    result['isolated_pass_test_passed']=result['maximum_absolute_linear_channel_residual']<1e-4
    if not result['isolated_pass_test_passed']:raise RuntimeError(json.dumps(result))
    exe=str(ROOT/'build/cybr-film');tiny=ROOT/'renders/resume-fixture'
    base=[exe,'--assets',str(ROOT/'assets'),'--out',str(tiny),'--mode','uncached-film','--width','24','--height','16','--samples','2','--frames','2','--first','0','--last','0','--threads','2','--no-temporal']
    subprocess.run(base,check=True,stdout=subprocess.DEVNULL)
    subprocess.run([*base,'--resume'],check=True,stdout=subprocess.DEVNULL)
    changes=[['--sun-scale','1.1'],['--sky-scale','.9'],['--fog','.006'],['--wind','1'],['--aperture','.003'],['--focus','5'],['--exposure','2.3'],['--fps','30']]
    checks=[]
    for more in changes:
        p=subprocess.run([*base,'--resume',*more],capture_output=True,text=True)
        checks.append({'change':more,'rejected':p.returncode!=0 and 'fingerprint mismatch' in p.stderr})
    result['resume_mutations']=checks
    if not all(x['rejected'] for x in checks):raise RuntimeError('Output identity regression')
    result['geometry_sha256']=hashlib.sha256((ROOT/'assets/forest.cys').read_bytes()).hexdigest()
    (ROOT/'reports/lighting-and-resume.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))
if __name__=='__main__':main()
