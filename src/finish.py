#!/usr/bin/env python3
"""Exposure, optional non-neural edge-aware filtering, and PNG conversion.
The untouched linear PFM is retained. Filtering never synthesizes objects.
"""
from pathlib import Path
import argparse,json,struct
import numpy as np
from PIL import Image

def read_pfm(path):
    with open(path,'rb') as f:
        if f.readline().strip()!=b'PF':raise ValueError('Expected RGB PFM')
        w,h=map(int,f.readline().split());scale=float(f.readline());a=np.frombuffer(f.read(),dtype='<f4' if scale<0 else '>f4').reshape(h,w,3)
    return np.flipud(a).copy()

def aces(a,exposure):
    v=np.maximum(0,a*exposure);v=np.clip(v*(2.51*v+.03)/(v*(2.43*v+.59)+.14),0,1)
    return np.where(v<=.0031308,12.92*v,1.055*v**(1/2.4)-.055)

def read_var(base,shape):
    b=Path(str(base)+'.accum').read_bytes()
    dt=np.dtype([('mean','<f4',(3,)),('m2','<f4'),('n','<u4')]);a=np.frombuffer(b,offset=24,dtype=dt).reshape(shape)
    return np.maximum(a['m2'],0)/np.maximum(1,a['n']-1)/np.maximum(1,a['n'])

def shift(a,dy,dx):
    # Edge clamping prevents wrapping the far edge of the frame into the image.
    h,w=a.shape[:2];yi=np.clip(np.arange(h)+dy,0,h-1);xi=np.clip(np.arange(w)+dx,0,w-1)
    return a[yi[:,None],xi[None,:]]

def denoise(base,color,iterations=3):
    n=read_pfm(str(base)+'.normal.pfm');a=read_pfm(str(base)+'.albedo.pfm');z=read_pfm(str(base)+'.depth.pfm')[...,0]
    var=read_var(base,color.shape[:2]);filtered=color.copy();lum0=color@np.array([.2126,.7152,.0722],dtype='f4')
    for iteration in range(iterations):
        stride=2**iteration;acc=np.zeros_like(color);weights=np.zeros_like(z);variance=np.zeros_like(z)
        center_lum=filtered@np.array([.2126,.7152,.0722],dtype='f4')
        for dy in [-2,-1,0,1,2]:
            for dx in [-2,-1,0,1,2]:
                kernel=[1,4,6,4,1][dy+2]*[1,4,6,4,1][dx+2]/256
                fy,fx=dy*stride,dx*stride;cj=shift(filtered,fy,fx);nj=shift(n,fy,fx);aj=shift(a,fy,fx);zj=shift(z,fy,fx);vj=shift(var,fy,fx)
                normal=.05+.95*np.exp(-np.maximum(0,1-np.sum(n*nj,axis=2))*12)
                both_sky=(z>99999)&(zj>99999)
                normal=np.where(both_sky,1.,normal)
                alb=np.exp(-np.sum((a-aj)**2,axis=2)/.018)
                depth=np.exp(-np.abs(z-zj)/(.12+.055*np.minimum(z,zj)*stride))
                lj=cj@np.array([.2126,.7152,.0722],dtype='f4')
                lumi=np.exp(-np.abs(center_lum-lj)/(5.5*np.sqrt(var+vj+1e-8)+.006+center_lum*.04))
                weight=(kernel*normal*alb*depth*lumi).astype('f4')
                acc+=cj*weight[...,None];weights+=weight;variance+=weight*weight*vj
        filtered=acc/np.maximum(weights[...,None],1e-9);var=variance/np.maximum(weights*weights,1e-9)
    return filtered

def finish(base:Path,out:Path,exposure=1.4,iterations=0):
    color=read_pfm(str(base)+'.pfm')
    if iterations:color=denoise(base,color,iterations)
    Image.fromarray(np.uint8(np.clip(aces(color,exposure),0,1)*255+.5)).save(out)
    return color
if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('base',type=Path);ap.add_argument('out',type=Path);ap.add_argument('--exposure',type=float,default=1.4);ap.add_argument('--filter',type=int,default=0);a=ap.parse_args();finish(a.base,a.out,a.exposure,a.filter)
