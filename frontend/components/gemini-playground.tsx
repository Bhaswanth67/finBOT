'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Mic, StopCircle, Video, Monitor } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { base64ToFloat32Array, float32ToPcm16 } from '@/lib/utils';

interface Config {
  systemPrompt: string;
  voice: string;
  allowInterruptions: boolean;
}

export default function GeminiVoiceChat() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);
  const [text, setText] = useState('');
  const [config, setConfig] = useState<Config>({
    systemPrompt: `You are a highly advanced Real-Time Financial Assistant Chatbot that specializes in answering user queries related to stock markets, personal finance, investment strategies, cryptocurrencies, and financial trends. You retrieve real-time data from APIs, analyze multi-modal inputs (text, graphs, images, and financial reports), and generate factually accurate, user-personalized insights.`,
    voice: "Puck",
    allowInterruptions: false
  });
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const audioInputRef = useRef(null);
  const clientId = useRef(crypto.randomUUID());
  const [videoEnabled, setVideoEnabled] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const videoIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [chatMode, setChatMode] = useState<'audio' | 'video' | null>(null);
  const [videoSource, setVideoSource] = useState<'camera' | 'screen' | null>(null);

  let audioBuffer = [];
  let isPlaying = false;

  const startStream = async (mode: 'audio' | 'camera' | 'screen') => {
    if (mode !== 'audio') {
      setChatMode('video');
    } else {
      setChatMode('audio');
    }

    wsRef.current = new WebSocket(`ws://localhost:7523/ws/${clientId.current}`);
    //wsRef.current = new WebSocket(`wss://finbotbackend.azurewebsites.net/ws/${clientId.current}`);
    
    wsRef.current.onopen = async () => {
      wsRef.current.send(JSON.stringify({
        type: 'config',
        config: config
      }));
      
      await startAudioStream();

      if (mode !== 'audio') {
        setVideoEnabled(true);
        setVideoSource(mode);
      }

      setIsStreaming(true);
      setIsConnected(true);
    };

    wsRef.current.onmessage = async (event) => {
      const response = JSON.parse(event.data);
      if (response.type === 'audio') {
        const audioData = base64ToFloat32Array(response.data);
        playAudioData(audioData);
      } else if (response.type === 'text') {
        setText(prev => prev + response.text + '\n');
      }
    };

    wsRef.current.onerror = (error) => {
      setError('WebSocket error: ' + error.message);
      setIsStreaming(false);
    };

    wsRef.current.onclose = () => {
      setIsStreaming(false);
    };
  };

  const startAudioStream = async () => {
    try {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000
      });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = audioContextRef.current.createMediaStreamSource(stream);
      const processor = audioContextRef.current.createScriptProcessor(512, 1, 1);
      
      processor.onaudioprocess = (e) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          const pcmData = float32ToPcm16(inputData);
          const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
          wsRef.current.send(JSON.stringify({
            type: 'audio',
            data: base64Data
          }));
        }
      };

      source.connect(processor);
      processor.connect(audioContextRef.current.destination);
      
      audioInputRef.current = { source, processor, stream };
      setIsStreaming(true);
    } catch (err) {
      setError('Failed to access microphone: ' + err.message);
    }
  };

  const stopStream = () => {
    if (audioInputRef.current) {
      const { source, processor, stream } = audioInputRef.current;
      source.disconnect();
      processor.disconnect();
      stream.getTracks().forEach(track => track.stop());
      audioInputRef.current = null;
    }

    if (chatMode === 'video') {
      setVideoEnabled(false);
      setVideoSource(null);

      if (videoStreamRef.current) {
        videoStreamRef.current.getTracks().forEach(track => track.stop());
        videoStreamRef.current = null;
      }
      if (videoIntervalRef.current) {
        clearInterval(videoIntervalRef.current);
        videoIntervalRef.current = null;
      }
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setIsStreaming(false);
    setIsConnected(false);
    setChatMode(null);
  };

  const playAudioData = async (audioData) => {
    audioBuffer.push(audioData);
    if (!isPlaying) {
      playNextInQueue();
    }
  };

  const playNextInQueue = async () => {
    if (!audioContextRef.current || audioBuffer.length === 0) {
      isPlaying = false;
      return;
    }

    isPlaying = true;
    const audioData = audioBuffer.shift();

    const buffer = audioContextRef.current.createBuffer(1, audioData.length, 24000);
    buffer.copyToChannel(audioData, 0);

    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);
    source.onended = () => {
      playNextInQueue();
    };
    source.start();
  };

  useEffect(() => {
    if (videoEnabled && videoRef.current) {
      const startVideo = async () => {
        try {
          let stream;
          if (videoSource === 'camera') {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { width: { ideal: 320 }, height: { ideal: 240 } }
            });
          } else if (videoSource === 'screen') {
            stream = await navigator.mediaDevices.getDisplayMedia({
              video: { width: { ideal: 1920 }, height: { ideal: 1080 } }
            });
          }
          
          videoRef.current.srcObject = stream;
          videoStreamRef.current = stream;
          
          videoIntervalRef.current = setInterval(() => {
            captureAndSendFrame();
          }, 1000);

        } catch (err) {
          console.error('Video initialization error:', err);
          setError('Failed to access camera/screen: ' + err.message);

          if (videoSource === 'screen') {
            setChatMode(null);
            stopStream();
          }

          setVideoEnabled(false);
          setVideoSource(null);
        }
      };

      startVideo();

      return () => {
        if (videoStreamRef.current) {
          videoStreamRef.current.getTracks().forEach(track => track.stop());
          videoStreamRef.current = null;
        }
        if (videoIntervalRef.current) {
          clearInterval(videoIntervalRef.current);
          videoIntervalRef.current = null;
        }
      };
    }
  }, [videoEnabled, videoSource]);

  const captureAndSendFrame = () => {
    if (!canvasRef.current || !videoRef.current || !wsRef.current) return;
    
    const context = canvasRef.current.getContext('2d');
    if (!context) return;
    
    canvasRef.current.width = videoRef.current.videoWidth;
    canvasRef.current.height = videoRef.current.videoHeight;
    
    context.drawImage(videoRef.current, 0, 0);
    const base64Image = canvasRef.current.toDataURL('image/jpeg').split(',')[1];
    
    wsRef.current.send(JSON.stringify({
      type: 'image',
      data: base64Image
    }));
  };

  useEffect(() => {
    return () => {
      stopStream();
    };
  }, []);

  return (
    <div className="bg-[#000000] text-[hsl(45,94.30%,86.30%)] font-serif min-h-screen p-8">
      <div className="flex gap-6">
        {/* Sidebar */}
        <div className="w-64 bg-[#1A1A1A] p-4 rounded-lg">
          {isStreaming ? (
            <div className="space-y-4">
              <p className="text-lg font-semibold">
                Current Mode: {chatMode === 'audio' ? 'Voice' : videoSource === 'camera' ? 'Camera' : 'Screen'}
              </p>
              <Button
                onClick={stopStream}
                className="w-full bg-red-600 text-white hover:bg-red-700"
              >
                <StopCircle className="h-4 w-4 mr-2" />
                Stop Chat
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-lg font-semibold">Select Chat Mode</p>
              <Button
                onClick={() => startStream('audio')}
                className="w-full bg-[#BEB09E] text-[#000000] hover:bg-[#A89C8E]"
              >
                <Mic className="h-4 w-4 mr-2" />
                Voice Chat
              </Button>
              <Button
                onClick={() => startStream('camera')}
                className="w-full bg-[#BEB09E] text-[#000000] hover:bg-[#A89C8E]"
              >
                <Video className="h-4 w-4 mr-2" />
                Camera Chat
              </Button>
              <Button
                onClick={() => startStream('screen')}
                className="w-full bg-[#BEB09E] text-[#000000] hover:bg-[#A89C8E]"
              >
                <Monitor className="h-4 w-4 mr-2" />
                Screen Chat
              </Button>
            </div>
          )}
        </div>

        {/* Main Content */}
        <div className="flex-1 space-y-6">
          <h1 className="text-4xl font-bold">FinBot 🤖</h1>

          {error && (
            <Alert variant="destructive" className="bg-red-900 text-white">
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {!isStreaming && (
            <Card className="min-h-[100px] bg-[#000000] !bg-[#000000] text-[hsl(45,94.30%,86.30%)] border-[#BEB09E]">
              <CardContent className="pt-6">
                <Label htmlFor="system-prompt" className="text-[hsl(45,94.30%,86.30%)]">System Prompt</Label>
                <Textarea
                  id="system-prompt"
                  value={config.systemPrompt}
                  onChange={(e) => setConfig(prev => ({ ...prev, systemPrompt: e.target.value }))}
                  disabled={isConnected}
                  className="min-h-[100px] bg-[#000000] !bg-[#000000] text-[hsl(45,94.30%,86.30%)] border-[#BEB09E]"
                />
              </CardContent>
            </Card>
          )}

{isStreaming && (
  <Card className="min-h-[100px] bg-[#000000] !bg-[#000000] text-[hsl(45,94.30%,86.30%)] border-[#BEB09E]">
    <CardContent className="pt-6">
      <div className="flex items-center justify-center h-24">
        <Mic className="h-8 w-8 text-[#FFFFFF] animate-pulse" />
        <p className="ml-2 text-[#FFFFFF]">Listening...</p>
      </div>
    </CardContent>
  </Card>
)}

          {chatMode === 'video' && (
            <Card className="min-h-[100px] bg-[#000000] !bg-[#000000] text-[hsl(45,94.30%,86.30%)] border-[#BEB09E]">
              <CardContent className="pt-6">
                <h2 className="text-lg font-semibold mb-2">Video Input</h2>
                <div className="aspect-video bg-black rounded-lg overflow-hidden">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-contain"
                    style={{ transform: videoSource === 'camera' ? 'scaleX(-1)' : 'none' }}
                  />
                  <canvas ref={canvasRef} className="hidden" />
                </div>
              </CardContent>
            </Card>
          )}

          {text && (
            <Card className="min-h-[100px] bg-[#000000] !bg-[#000000] text-[hsl(45,94.30%,86.30%)] border-[#BEB09E]">
              <CardContent className="pt-6">
                <h2 className="text-lg font-semibold mb-2">Conversation:</h2>
                <pre className="whitespace-pre-wrap text-[hsl(45,94.30%,86.30%)]">{text}</pre>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}