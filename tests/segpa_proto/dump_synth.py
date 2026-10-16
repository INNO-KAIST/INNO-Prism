# Synthetic scenarios (mc.py / mc2.py) with truth, Python SegPA outputs, for the JS parity test.
import json,numpy as np,segpa,contextlib,io
with contextlib.redirect_stdout(io.StringIO()):
    import mc
x=mc.x; dx=x[1]-x[0]; out=[]
for name,(f,truth) in mc.S.items():
    for seed in range(20):
        rng=np.random.default_rng(seed); xs=x+rng.uniform(0,dx); kw={}
        if truth in ('noisy','noisyA'): kw=dict(mult=0.08,spikes=8)
        fx=f if f is not None else None
        P,R=mc.gen(rng,fx,xs,**kw)
        if truth=='glitch': R[rng.integers(20,70)]*=8
        o=segpa.analyze(P,reps=R)
        res=[dict(head=q['pa_head'],headLo=q['pa_lo'],br0=float(q['bracket'][0]),br1=float(q['bracket'][1]),cls=q['cls'],status=q['status'],kind=q['kind'],
                  main=None if q['main'] is None else q['main']['slope']) for q in o['regimes']]
        out.append(dict(rel='synth:'+name,branch=str(seed),input=dict(P=P.tolist(),reps=R.tolist()),py=res,err=None,expect=truth if isinstance(truth,list) else truth))
json.dump(out,open('parity_synth.json','w')); print(len(out))
