package com.example.streampitv.data

import retrofit2.http.GET

interface FirebaseApiService {
    @GET("serverConfig.json")
    suspend fun getConfig(): FirebaseServerConfig
}
