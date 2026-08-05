import React, { useState } from 'react';
import { Magnet, Send } from 'lucide-react';
import TelegramBrowser from './TelegramBrowser';
import TorrentManager from './TorrentManager';

const Discovery = ({ token, serverUrl, library }) => {
    const [activeSubTab, setActiveSubTab] = useState('telegram');

    return (
        <div className="space-y-6">
            {/* Submenu Header */}
            <div className="flex items-center gap-4 border-b border-gray-800 pb-1">
                <button 
                    onClick={() => setActiveSubTab('telegram')}
                    className={`pb-3 px-2 text-sm font-bold flex items-center gap-2 transition-all border-b-2 ${
                        activeSubTab === 'telegram' 
                        ? 'border-blue-500 text-blue-400' 
                        : 'border-transparent text-gray-500 hover:text-gray-300'
                    }`}
                >
                    <Send className="w-4 h-4" /> Telegram
                </button>

                <button 
                    onClick={() => setActiveSubTab('torrent')}
                    className={`pb-3 px-2 text-sm font-bold flex items-center gap-2 transition-all border-b-2 ${
                        activeSubTab === 'torrent' 
                        ? 'border-red-500 text-red-500' 
                        : 'border-transparent text-gray-500 hover:text-gray-300'
                    }`}
                >
                    <Magnet className="w-4 h-4" /> Torrents
                </button>
            </div>

            {/* Content Area */}
            <div className="min-h-[60vh]">
                {activeSubTab === 'telegram' ? (
                    <TelegramBrowser token={token} serverUrl={serverUrl} library={library} />
                ) : (
                    <TorrentManager token={token} serverUrl={serverUrl} />
                )}
            </div>
        </div>
    );
};

export default Discovery;
